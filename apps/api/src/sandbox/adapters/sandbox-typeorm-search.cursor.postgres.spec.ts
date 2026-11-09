/* Copyright Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { DataSource, EntitySchema } from 'typeorm'
import { SandboxTypeormSearchAdapter } from './sandbox-typeorm-search.adapter'
import { SandboxSearchSortDirection, SandboxSearchSortField } from '../interfaces/sandbox-search.interface'

const url = process.env.DAYTONA_CURSOR_TEST_DATABASE_URL
const integration = url ? describe : describe.skip
const ids = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
  '44444444-4444-4444-8444-444444444444',
]
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const sandboxSchema = new EntitySchema({
  name: 'CursorSandbox',
  tableName: 'cursor_test_sandbox',
  columns: {
    id: { type: 'uuid', primary: true },
    organizationId: { type: 'uuid' },
    name: { type: String },
    state: { type: String },
    desiredState: { type: String },
    createdAt: { type: 'timestamptz' },
    updatedAt: { type: 'timestamptz' },
  },
  relations: {
    lastActivityAt: { type: 'one-to-one', target: 'CursorActivity', inverseSide: 'sandbox' },
  },
})
const activitySchema = new EntitySchema({
  name: 'CursorActivity',
  tableName: 'cursor_test_activity',
  columns: {
    sandboxId: { type: 'uuid', primary: true },
    lastActivityAt: { type: 'timestamptz', nullable: true },
  },
  relations: {
    sandbox: {
      type: 'one-to-one', target: 'CursorSandbox', inverseSide: 'lastActivityAt',
      joinColumn: { name: 'sandboxId', referencedColumnName: 'id' },
    },
  },
})

integration('PostgreSQL sandbox cursor precision', () => {
  let db: DataSource
  let adapter: SandboxTypeormSearchAdapter

  beforeAll(async () => {
    if (!url) throw new Error('Dedicated cursor test database is required')
    const target = new URL(url)
    if (!['postgres:', 'postgresql:'].includes(target.protocol) ||
      !['localhost', '127.0.0.1'].includes(target.hostname) || target.pathname !== '/daytona_cursor_test') {
      throw new Error('Expected the dedicated local CI daytona_cursor_test database')
    }
    db = new DataSource({ type: 'postgres', url, entities: [sandboxSchema, activitySchema], synchronize: true, dropSchema: true })
    await db.initialize()
    adapter = new SandboxTypeormSearchAdapter(db.getRepository('CursorSandbox') as never)
    for (let i = 0; i < ids.length; i += 1) {
      const created = i < 2 ? '2026-11-09 00:00:00.123001+00' : i === 2
        ? '2026-11-09 00:00:00.123002+00' : '2026-11-09 00:00:00.124000+00'
      await db.query('INSERT INTO cursor_test_sandbox (id, "organizationId", name, state, "desiredState", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6::timestamptz,$6::timestamptz)',
        [ids[i], organizationId, `sandbox-${i}`, 'started', 'started', created])
      if (i < 2) {
        await db.query('INSERT INTO cursor_test_activity ("sandboxId", "lastActivityAt") VALUES ($1,$2::timestamptz)',
          [ids[i], i === 0 ? '2026-11-09 00:00:00.123001+00' : '2026-11-09 00:00:00.123002+00'])
      }
    }
  })

  afterAll(async () => { if (db?.isInitialized) await db.destroy() })

  async function pages(field: SandboxSearchSortField, direction: SandboxSearchSortDirection): Promise<string[]> {
    let cursor: string | undefined
    const seen: string[] = []
    for (let i = 0; i < 10; i += 1) {
      const result = await adapter.search({
        filters: { organizationId }, pagination: { limit: 1, cursor }, sort: { field, direction },
      })
      seen.push(...result.items.map((item) => item.id))
      if (!result.nextCursor) return seen
      cursor = result.nextCursor
    }
    throw new Error('Pagination did not terminate')
  }

  it('returns every createdAt row once in both directions across microsecond and equal-time boundaries', async () => {
    expect(await pages(SandboxSearchSortField.CREATED_AT, SandboxSearchSortDirection.ASC)).toEqual(ids)
    expect(await pages(SandboxSearchSortField.CREATED_AT, SandboxSearchSortDirection.DESC)).toEqual([...ids].reverse())
  })

  it('continues from non-null activity to null activity rows in both directions', async () => {
    expect(await pages(SandboxSearchSortField.LAST_ACTIVITY_AT, SandboxSearchSortDirection.ASC)).toEqual(ids)
    expect(await pages(SandboxSearchSortField.LAST_ACTIVITY_AT, SandboxSearchSortDirection.DESC)).toEqual([ids[1], ids[0], ids[3], ids[2]])
  })
})
