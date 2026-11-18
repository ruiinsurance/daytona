/* Copyright Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { ConflictException } from '@nestjs/common'
import { v5 as uuidv5 } from 'uuid'
import { isCanonicalV4Uuid } from '../../common/utils/uuid'
import { Sandbox } from '../entities/sandbox.entity'
import { Job } from '../entities/job.entity'
import { Snapshot } from '../entities/snapshot.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'

function unavailable(): never {
  throw new ConflictException('Historical workspace recovery metadata is incomplete or conflicting')
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable()
  return value as Record<string, unknown>
}
function parse(value: string | null): Record<string, unknown> {
  try { return record(JSON.parse(value ?? 'null')) } catch { return unavailable() }
}

/**
 * Compatibility only for a provably unchanged, standard local sandbox. A
 * single completed create, exact completed destruction and unchanged catalog
 * image are required. No default image/owner/resource inference is permitted.
 */
export function historicalWorkspaceRecoverySandbox(input: {
  sandboxId: string; organizationId: string; ownerRunnerId: string;
  expectedSnapshot: string; snapshot: Snapshot;
  /** Newest first, ordered by PostgreSQL createdAt/id without Date keysets. */
  jobs: readonly Job[];
}): Sandbox {
  const { sandboxId, organizationId, ownerRunnerId, snapshot, jobs } = input
  if (!isCanonicalV4Uuid(sandboxId) || !isCanonicalV4Uuid(ownerRunnerId) || jobs.length === 0 || jobs.length > 100 ||
    snapshot.name !== input.expectedSnapshot || (!snapshot.general && snapshot.organizationId !== organizationId) ||
    !snapshot.ref || snapshot.sandboxClass !== SandboxClass.CONTAINER ||
    jobs.some(job => job.resourceId !== sandboxId || job.resourceType !== ResourceType.SANDBOX || !job.completedAt)) return unavailable()
  const successful = jobs.filter(job => job.status === JobStatus.COMPLETED)
  const creates = successful.filter(job => job.type === JobType.CREATE_SANDBOX)
  if (creates.length !== 1 || successful[0]?.type !== JobType.DESTROY_SANDBOX_WORKSPACE || jobs[0] !== successful[0]) return unavailable()
  const create = creates[0], destruction = successful[0]
  const payload = parse(create.payload), removed = parse(destruction.payload), evidence = parse(destruction.resultMetadata)
  const unchanged = new Set<JobType>([JobType.START_SANDBOX, JobType.STOP_SANDBOX,
    JobType.DESTROY_SANDBOX, JobType.DESTROY_SANDBOX_WORKSPACE, JobType.CREATE_BACKUP])
  if (jobs.slice(0, jobs.indexOf(create)).some(job => !unchanged.has(job.type))) return unavailable()
  if (!isCanonicalV4Uuid(create.id) || create.runnerId !== ownerRunnerId || destruction.runnerId !== ownerRunnerId ||
    payload.id !== sandboxId || (payload.organizationId !== undefined && payload.organizationId !== organizationId) || payload.userId !== organizationId ||
    payload.snapshot !== snapshot.ref || payload.sandboxClass !== SandboxClass.CONTAINER || payload.linkedSandboxId ||
    typeof payload.regionId !== 'string' || !payload.regionId || typeof payload.osUser !== 'string' || !payload.osUser ||
    typeof payload.authToken !== 'string' || !payload.authToken || payload.authToken.length > 256 ||
    ![payload.cpuQuota, payload.memoryQuota, payload.storageQuota].every(value => Number.isSafeInteger(value) && Number(value) > 0) ||
    payload.gpuQuota !== 0 || typeof payload.networkBlockAll !== 'boolean') return unavailable()
  const env = record(payload.env)
  if (Object.values(env).some(value => typeof value !== 'string')) return unavailable()
  for (const name of ['networkAllowList', 'domainAllowList']) {
    if (payload[name] != null && typeof payload[name] !== 'string') return unavailable()
  }
  if (!Array.isArray(payload.volumes) || payload.volumes.length !== 2) return unavailable()
  const volumes = payload.volumes.map(record)
  const workspace = volumes.find(volume => volume.mountPath === '/workspace')
  const config = volumes.find(volume => volume.mountPath === '/config')
  const subpath = `sandboxes/${sandboxId}/workspace`
  if (!workspace || !config || typeof workspace.volumeId !== 'string' || !isCanonicalV4Uuid(workspace.volumeId) || workspace.subpath !== subpath ||
    config.volumeId !== workspace.volumeId || config.subpath !== subpath ||
    // Older runner payloads used userId as the organization namespace and
    // omitted backend. The completed dedicated local-destruction evidence below
    // proves that backend; an explicitly different backend is never accepted.
    volumes.some(volume => volume.backend !== undefined && volume.backend !== 'local') ||
    removed.ownerRunnerId !== ownerRunnerId || removed.volumeId !== workspace.volumeId || removed.subpath !== subpath ||
    typeof removed.operationId !== 'string' || !isCanonicalV4Uuid(removed.operationId) || destruction.id !== uuidv5('destroy-workspace', removed.operationId) ||
    evidence.operationId !== removed.operationId || evidence.sandboxId !== sandboxId || evidence.ownerRunnerId !== ownerRunnerId ||
    evidence.volumeId !== workspace.volumeId || evidence.subpath !== subpath ||
    !['removed', 'already_absent'].includes(String(evidence.outcome))) return unavailable()
  const sandbox = new Sandbox({ id: sandboxId, name: `restored-${sandboxId}`, region: payload.regionId })
  Object.assign(sandbox, {
    organizationId, runnerId: ownerRunnerId, storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.DESTROYED, desiredState: SandboxDesiredState.DESTROYED, pending: false,
    snapshot: snapshot.name, sandboxClass: snapshot.sandboxClass, osUser: payload.osUser,
    cpu: payload.cpuQuota, gpu: 0, mem: payload.memoryQuota, disk: payload.storageQuota,
    // Historical rotated daemon tokens must never be made valid again.
    env, networkBlockAll: payload.networkBlockAll,
    networkAllowList: payload.networkAllowList ?? null, domainAllowList: payload.domainAllowList ?? null,
    volumes: [{ volumeId: workspace.volumeId, mountPath: '/workspace', subpath },
      { volumeId: workspace.volumeId, mountPath: '/config', subpath }],
    // Original idle policy/public-sharing fields were not in CREATE payloads.
    // Keep compute private and disable provider auto-deletion until Suna reapplies
    // its persisted policy. Never invent an aggressive default or public access.
    public: false, autoStopInterval: 0, autoArchiveInterval: 0, autoDeleteInterval: -1,
    createdAt: create.createdAt, updatedAt: new Date(),
  })
  sandbox.assertValid()
  sandbox.enforceInvariants()
  return sandbox
}
