/* Copyright Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */
import { v5 as uuidv5 } from 'uuid'
import { historicalWorkspaceRecoverySandbox } from './historical-workspace-recovery'
import { Job } from '../entities/job.entity'
import { Snapshot } from '../entities/snapshot.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const operationId = '55555555-5555-4555-8555-555555555555'
const subpath = `sandboxes/${sandboxId}/workspace`

function fixture() {
  const snapshot = Object.assign(new Snapshot(), { name: 'persisted-snapshot', ref: 'registry/image@sha256:fixture',
    organizationId, general: false, sandboxClass: SandboxClass.CONTAINER })
  const payload = { id: sandboxId, userId: organizationId, organizationId,
    snapshot: snapshot.ref, sandboxClass: SandboxClass.CONTAINER, regionId: 'local', osUser: 'abc',
    cpuQuota: 4, gpuQuota: 0, memoryQuota: 8, storageQuota: 50,
    env: { PRIVATE_USER_SETTING: 'test-only-canary' }, authToken: 'test-private-daemon-token',
    networkBlockAll: true, networkAllowList: '10.0.0.0/8', domainAllowList: 'example.test',
    volumes: [{ volumeId, mountPath: '/workspace', subpath, backend: 'local' },
      { volumeId, mountPath: '/config', subpath, backend: 'local' }] }
  const create = Object.assign(new Job(), { id: '66666666-6666-4666-8666-666666666666',
    type: JobType.CREATE_SANDBOX, status: JobStatus.COMPLETED, runnerId: ownerRunnerId,
    resourceType: ResourceType.SANDBOX, resourceId: sandboxId,
    createdAt: new Date('2026-10-01'), completedAt: new Date('2026-10-01'), payload: JSON.stringify(payload) })
  const destruction = Object.assign(new Job(), { id: uuidv5('destroy-workspace', operationId),
    type: JobType.DESTROY_SANDBOX_WORKSPACE, status: JobStatus.COMPLETED, runnerId: ownerRunnerId,
    resourceType: ResourceType.SANDBOX, resourceId: sandboxId,
    createdAt: new Date('2026-11-01'), completedAt: new Date('2026-11-01'),
    payload: JSON.stringify({ operationId, ownerRunnerId, volumeId, subpath }),
    resultMetadata: JSON.stringify({ operationId, ownerRunnerId, volumeId, subpath, sandboxId, outcome: 'removed' }) })
  return { sandboxId, organizationId, ownerRunnerId, expectedSnapshot: snapshot.name, snapshot,
    jobs: [destruction, create], payload, create, destruction }
}

it('reconstructs only the exact same image/organization/owner and proven configuration', () => {
  const input = fixture()
  const result = historicalWorkspaceRecoverySandbox(input)
  expect(result).toMatchObject({ id: sandboxId, organizationId, runnerId: ownerRunnerId,
    snapshot: input.snapshot.name, cpu: 4, gpu: 0, mem: 8, disk: 50,
    env: input.payload.env, networkBlockAll: true,
    networkAllowList: '10.0.0.0/8', domainAllowList: 'example.test',
    state: 'destroyed', desiredState: 'destroyed', public: false,
    autoStopInterval: 0, autoArchiveInterval: 0, autoDeleteInterval: -1 })
  expect(result.volumes).toEqual(input.payload.volumes.map(({ backend: _backend, ...mount }) => mount))
  expect(result.authToken).not.toBe(input.payload.authToken)
  expect(result.authToken.length).toBeGreaterThanOrEqual(32)
})

it.each(['organization', 'owner', 'snapshot', 'resource', 'linked', 'evidence', 'incomplete', 'drift'])(
  'rejects %s conflicts instead of choosing defaults or another owner', kind => {
    const input = fixture()
    if (kind === 'organization') input.organizationId = ownerRunnerId
    if (kind === 'owner') input.ownerRunnerId = organizationId
    if (kind === 'snapshot') input.snapshot.ref = 'registry/unrelated-image'
    if (kind === 'resource') { delete (input.payload as Partial<typeof input.payload>).cpuQuota; input.create.payload = JSON.stringify(input.payload) }
    if (kind === 'linked') input.create.payload = JSON.stringify({ ...input.payload, linkedSandboxId: operationId })
    if (kind === 'evidence') input.destruction.resultMetadata = JSON.stringify({ outcome: 'removed' })
    if (kind === 'incomplete') input.destruction.completedAt = null
    if (kind === 'drift') input.jobs.splice(1, 0, Object.assign(new Job(), input.create, {
      id: operationId, type: JobType.RESIZE_SANDBOX, createdAt: new Date('2026-10-20'),
    }))
    expect(() => historicalWorkspaceRecoverySandbox(input)).toThrow('incomplete or conflicting')
  },
)
