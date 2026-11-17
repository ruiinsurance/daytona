/* Copyright Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { ConflictException } from '@nestjs/common'
import type { EntityManager } from 'typeorm'
import { isCanonicalV4Uuid } from '../../common/utils/uuid'

type QueryManager = Pick<EntityManager, 'query'>
export type RetainedSandboxMetadata = Record<string, unknown>
interface RawSandbox { metadata: RetainedSandboxMetadata }
interface RetainedRow { schemaVersion: number; metadata: RetainedSandboxMetadata }

async function lockRecoveryIdentity(manager: QueryManager, sandboxId: string): Promise<void> {
  await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace-recovery:'||$1::text,0))", [sandboxId])
}

export async function assertSandboxIdentityNotRetained(manager: QueryManager, sandboxId: string): Promise<void> {
  await lockRecoveryIdentity(manager, sandboxId)
  const retained: Array<{ sandboxId: string }> = await manager.query(
    'SELECT "sandboxId" FROM sandbox_workspace_recovery_metadata WHERE "sandboxId"=$1::uuid', [sandboxId])
  if (retained.length) throw new ConflictException('Sandbox identity is reserved for workspace recovery')
}

function canonicalWorkspace(metadata: RetainedSandboxMetadata): boolean {
  if (metadata.storageBackend !== 'local' || !Array.isArray(metadata.volumes)) return false
  const expected = `sandboxes/${metadata.id}/workspace`
  const workspace = metadata.volumes.find(volume => volume?.mountPath === '/workspace')
  if (!workspace || !isCanonicalV4Uuid(workspace.volumeId) || workspace.subpath !== expected) return false
  const config = metadata.volumes.find(volume => volume?.mountPath === '/config')
  return !config || (config.volumeId === workspace.volumeId && config.subpath === expected)
}

function validateRetained(
  row: RetainedRow, sandboxId: string, organizationId: string, ownerRunnerId: string,
): RetainedSandboxMetadata {
  const metadata = row.metadata
  if (row.schemaVersion !== 1 || !metadata || metadata.id !== sandboxId ||
    metadata.organizationId !== organizationId || !canonicalWorkspace(metadata) ||
    metadata.state !== 'destroyed' || metadata.desiredState !== 'destroyed' || metadata.pending !== false ||
    (metadata.runnerId != null && metadata.runnerId !== ownerRunnerId)) {
    throw new ConflictException('Retained workspace recovery identity is unavailable or conflicting')
  }
  return metadata
}

/** Caller owns the transaction and the normal per-sandbox state-change lock. */
export async function archiveAndDeleteExpiredSandbox(
  manager: QueryManager, sandboxId: string, before: Date, assertLockOwned: () => Promise<void> = async () => {},
): Promise<boolean> {
  await lockRecoveryIdentity(manager, sandboxId)
  const rows: RawSandbox[] = await manager.query(`
    SELECT to_jsonb(s) AS metadata FROM sandbox s
    WHERE id=$1::uuid AND state='destroyed' AND "desiredState"='destroyed'
      AND pending=false AND "updatedAt"<$2::timestamptz FOR UPDATE`, [sandboxId, before.toISOString()])
  if (!rows.length) return false
  await assertLockOwned()
  const metadata = rows[0].metadata
  const claimsCanonicalWorkspace = metadata.storageBackend === 'local' && Array.isArray(metadata.volumes) &&
    metadata.volumes.some(volume => volume?.mountPath === '/workspace' && volume.subpath === `sandboxes/${sandboxId}/workspace`)
  if (claimsCanonicalWorkspace && !canonicalWorkspace(metadata)) {
    throw new ConflictException('Canonical local workspace metadata is invalid; cleanup refused')
  }
  if (canonicalWorkspace(metadata)) {
    const retained: Array<{ sandboxId: string }> = await manager.query(`
      INSERT INTO sandbox_workspace_recovery_metadata
        ("sandboxId", "organizationId", "schemaVersion", metadata, "providerUpdatedAt")
      VALUES ($1::uuid,$2::uuid,1,$3::jsonb,($3::jsonb->>'updatedAt')::timestamptz)
      ON CONFLICT ("sandboxId") DO UPDATE SET
        "schemaVersion"=EXCLUDED."schemaVersion", metadata=EXCLUDED.metadata,
        "providerUpdatedAt"=EXCLUDED."providerUpdatedAt", "updatedAt"=now()
      WHERE sandbox_workspace_recovery_metadata."organizationId"=EXCLUDED."organizationId"
        AND sandbox_workspace_recovery_metadata."providerUpdatedAt"<=EXCLUDED."providerUpdatedAt"
      RETURNING "sandboxId"`, [sandboxId, metadata.organizationId, JSON.stringify(metadata)])
    if (retained.length !== 1) throw new ConflictException('Workspace recovery metadata changed during cleanup')
  }
  await assertLockOwned()
  const deleted: Array<{ id: string }> = await manager.query('DELETE FROM sandbox WHERE id=$1::uuid RETURNING id', [sandboxId])
  return deleted.length === 1
}

/** Read only. No ordinary GET/start path can materialize a provider row. */
export async function loadRetainedSandboxMetadata(
  manager: QueryManager, sandboxId: string, organizationId: string, ownerRunnerId: string,
): Promise<RetainedSandboxMetadata | null> {
  const rows: RetainedRow[] = await manager.query(`SELECT "schemaVersion",metadata
    FROM sandbox_workspace_recovery_metadata
    WHERE "sandboxId"=$1::uuid AND "organizationId"=$2::uuid`, [sandboxId, organizationId])
  return rows.length ? validateRetained(rows[0], sandboxId, organizationId, ownerRunnerId) : null
}

/** Rehydrate only a server-owned recipe; never accept a caller-provided descriptor. */
export async function restoreRetainedSandboxMetadata(
  manager: QueryManager, sandboxId: string, organizationId: string, ownerRunnerId: string,
): Promise<boolean> {
  await lockRecoveryIdentity(manager, sandboxId)
  const metadata = await loadRetainedSandboxMetadata(manager, sandboxId, organizationId, ownerRunnerId)
  if (!metadata) return false
  const existing: RawSandbox[] = await manager.query('SELECT to_jsonb(s) AS metadata FROM sandbox s WHERE id=$1::uuid FOR UPDATE', [sandboxId])
  if (existing.length) {
    validateRetained({ schemaVersion: 1, metadata: existing[0].metadata }, sandboxId, organizationId, ownerRunnerId)
    return true
  }
  // Use only actual server-catalog column names. Persisted fields retain their
  // exact PostgreSQL types/precision; newly added columns get database defaults.
  // Removed fields and missing required defaults require an explicit migration.
  const columns: Array<{ name: string }> = await manager.query(`SELECT attname AS name
    FROM pg_attribute WHERE attrelid='sandbox'::regclass AND attnum>0 AND NOT attisdropped
      AND attgenerated='' AND attname=ANY($1::text[]) ORDER BY attnum`, [Object.keys(metadata)])
  if (columns.length !== Object.keys(metadata).length || columns.some(column => !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column.name))) {
    throw new ConflictException('Retained workspace metadata requires schema migration')
  }
  const names = columns.map(column => `"${column.name}"`).join(',')
  await manager.query(`INSERT INTO sandbox (${names})
    SELECT ${names} FROM jsonb_populate_record(NULL::sandbox,
      $1::jsonb || jsonb_build_object('updatedAt',now()))`, [JSON.stringify(metadata)])
  return true
}
