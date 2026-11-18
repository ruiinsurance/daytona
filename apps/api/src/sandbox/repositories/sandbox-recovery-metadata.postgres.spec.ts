/* Copyright Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { DataSource } from 'typeorm'
import { v5 as uuidv5 } from 'uuid'
import {
  archiveAndDeleteExpiredSandbox,
  assertSandboxIdentityNotRetained,
  loadRetainedSandboxMetadata,
  restoreRetainedSandboxMetadata,
} from './sandbox-recovery-metadata'
import { Migration1794895200000 } from '../../migrations/pre-deploy/1794895200000-migration'

const url = process.env.DAYTONA_RECOVERY_TEST_DATABASE_URL
const integration = url ? describe : describe.skip
const id = '11111111-1111-4111-8111-111111111111'
const org = '22222222-2222-4222-8222-222222222222'
const owner = '33333333-3333-4333-8333-333333333333'
const volume = '44444444-4444-4444-8444-444444444444'
const subpath = `sandboxes/${id}/workspace`

integration('retained local workspace metadata after PostgreSQL cleanup', () => {
  let db: DataSource
  beforeAll(async () => {
    if (!url) throw new Error('Dedicated recovery test database required')
    const target = new URL(url)
    if (!['127.0.0.1', 'localhost'].includes(target.hostname) || target.pathname !== '/daytona_recovery_test') {
      throw new Error('Expected isolated CI daytona_recovery_test database')
    }
    db = new DataSource({ type: 'postgres', url })
    await db.initialize()
    await db.query(`CREATE TABLE sandbox (
      id varchar PRIMARY KEY, "organizationId" uuid NOT NULL, "runnerId" uuid, "prevRunnerId" uuid,
      "storageBackend" text NOT NULL, state text NOT NULL, "desiredState" text NOT NULL,
      pending boolean NOT NULL, volumes jsonb NOT NULL, snapshot text,
      cpu integer NOT NULL, mem integer NOT NULL, disk integer NOT NULL, env jsonb NOT NULL,
      "authToken" text NOT NULL, "createdAt" timestamptz NOT NULL, "updatedAt" timestamptz NOT NULL
    )`)
    await db.query(`CREATE TABLE job (id uuid PRIMARY KEY,"resourceId" text,"resourceType" text,type text,
      status text,"runnerId" uuid,payload text,"resultMetadata" text,"createdAt" timestamptz)`)
    const runner = db.createQueryRunner()
    await new Migration1794895200000().up(runner)
    await runner.release()
  })
  afterAll(async () => { if (db?.isInitialized) await db.destroy() })
  beforeEach(async () => {
    await db.query('TRUNCATE sandbox, sandbox_workspace_recovery_metadata, job')
    await db.query(`INSERT INTO sandbox VALUES ($1,$2,$3,NULL,'local','destroyed','destroyed',false,$4::jsonb,
      'original-snapshot',4,8,50,'{"PRESERVE":"canary-secret"}', 'private-daemon-token',
      '2026-10-01 00:00:00.123456+00','2026-11-01 00:00:00.654321+00')`,
    [id, org, owner, JSON.stringify([{ volumeId: volume, mountPath: '/workspace', subpath },
      { volumeId: volume, mountPath: '/config', subpath }])])
  })

  it('atomically retains the full recipe and restores exact identity after the 24-hour cleanup', async () => {
    expect(await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))).toBe(true)
    expect(await db.query('SELECT id FROM sandbox')).toEqual([])
    const retained = await loadRetainedSandboxMetadata(db.manager, id, org, owner)
    expect(retained).toMatchObject({ id, organizationId: org, runnerId: owner, cpu: 4, mem: 8, disk: 50,
      snapshot: 'original-snapshot', env: { PRESERVE: 'canary-secret' }, authToken: 'private-daemon-token' })
    expect(retained?.updatedAt).toBe('2026-11-01T00:00:00.654321+00:00')
    await db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner))
    const [row] = await db.query('SELECT * FROM sandbox WHERE id=$1', [id])
    expect(row).toMatchObject({ id, organizationId: org, runnerId: owner, state: 'destroyed', pending: false,
      env: { PRESERVE: 'canary-secret' }, cpu: 4, mem: 8, disk: 50 })
    expect(row.volumes).toHaveLength(2)
    // Preserve the last pinned descriptor for operation replay; synthesizing a
    // legacy descriptor from old CREATE history instead generates a fresh token.
    expect(row.authToken).toBe('private-daemon-token')
  })

  it('does not leak or materialize another organization or owner', async () => {
    await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))
    expect(await loadRetainedSandboxMetadata(db.manager, id, owner, owner)).toBeNull()
    await expect(db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, org))).rejects.toThrow()
    expect(await db.query('SELECT id FROM sandbox')).toEqual([])
    await expect(db.transaction(tx => assertSandboxIdentityNotRetained(tx, id))).rejects.toThrow('reserved')
  })

  it('proves a legacy cleared owner from exact destruction evidence and retains that proof', async () => {
    const operation = '55555555-5555-4555-8555-555555555555'
    await db.query('UPDATE sandbox SET "runnerId"=NULL')
    await db.query(`INSERT INTO job VALUES ($1,$2,'SANDBOX','DESTROY_SANDBOX_WORKSPACE','COMPLETED',$3,$4,$5,now())`,
      [uuidv5('destroy-workspace', operation), id, owner,
        JSON.stringify({ operationId: operation, ownerRunnerId: owner, volumeId: volume, subpath }),
        JSON.stringify({ operationId: operation, ownerRunnerId: owner, volumeId: volume, subpath, sandboxId: id, outcome: 'removed' })])
    await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))
    // The durable descriptor no longer relies on future job-history retention.
    await db.query('DELETE FROM job')
    expect(await loadRetainedSandboxMetadata(db.manager, id, org, owner)).toMatchObject({ runnerId: null, prevRunnerId: owner })
    await expect(loadRetainedSandboxMetadata(db.manager, id, org, org)).rejects.toThrow()
    await db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner))
    expect((await db.query('SELECT "prevRunnerId" FROM sandbox'))[0]).toEqual({ prevRunnerId: owner })
  })

  it('rolls the delete back if retained metadata cannot be committed', async () => {
    await expect(db.transaction(async tx => {
      await archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03'))
      throw new Error('simulated transaction failure')
    })).rejects.toThrow('simulated transaction failure')
    expect(await db.query('SELECT id FROM sandbox')).toEqual([{ id }])
    expect(await db.query('SELECT "sandboxId" FROM sandbox_workspace_recovery_metadata')).toEqual([])
  })

  it('rolls archival back on state-change lease loss before deletion', async () => {
    let checks = 0
    await expect(db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03'), async () => {
      if (++checks === 2) throw new Error('lease lost')
    }))).rejects.toThrow('lease lost')
    expect(await db.query('SELECT id FROM sandbox')).toEqual([{ id }])
    expect(await db.query('SELECT "sandboxId" FROM sandbox_workspace_recovery_metadata')).toEqual([])
  })

  it('preserves old fields and applies defaults for later compatible columns', async () => {
    await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))
    await db.query('ALTER TABLE sandbox ADD COLUMN "laterDefault" integer NOT NULL DEFAULT 7')
    try {
      await db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner))
      expect((await db.query('SELECT "laterDefault",cpu FROM sandbox'))[0]).toEqual({ laterDefault: 7, cpu: 4 })
    } finally { await db.query('ALTER TABLE sandbox DROP COLUMN "laterDefault"') }
  })

  it('materializes exactly one identity when concurrent recovery requests replay the same retained recipe', async () => {
    await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))
    expect(await Promise.all([
      db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner)),
      db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner)),
    ])).toEqual([true, true])
    expect(await db.query('SELECT id,"organizationId","authToken" FROM sandbox')).toEqual([
      { id, organizationId: org, authToken: 'private-daemon-token' },
    ])
  })

  it('does not delete a newer/active row and preserves ordinary remote cleanup', async () => {
    await db.query("UPDATE sandbox SET state='started',\"desiredState\"='started'")
    expect(await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))).toBe(false)
    await db.query("UPDATE sandbox SET state='destroyed',\"desiredState\"='destroyed',\"storageBackend\"='remote'")
    expect(await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))).toBe(true)
    expect(await db.query('SELECT "sandboxId" FROM sandbox_workspace_recovery_metadata')).toEqual([])
  })

  it('replays materialization once and rejects an intervening active identity', async () => {
    await db.transaction(tx => archiveAndDeleteExpiredSandbox(tx, id, new Date('2026-11-03')))
    await Promise.all([1, 2].map(() => db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner))))
    expect(await db.query('SELECT id FROM sandbox')).toEqual([{ id }])
    await db.query("UPDATE sandbox SET state='started',\"desiredState\"='started'")
    await expect(db.transaction(tx => restoreRetainedSandboxMetadata(tx, id, org, owner))).rejects.toThrow()
  })
})
