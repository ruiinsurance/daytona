import axios from 'axios'
import { SandboxRebuildService } from './sandbox-rebuild.service'
import { Sandbox } from '../entities/sandbox.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'

const id = '45f43d73-8ece-4716-bcee-846bb044e373'
const ownerId = '3b16c312-b063-43e9-9ee7-b6a0fecdb16f'
const org = '22222222-2222-4222-8222-222222222222'
const volume = '44444444-4444-4444-8444-444444444444'

function fixture() {
  const sandbox = { id, name: 'visible-instance', organizationId: org, snapshot: 'old',
    state: SandboxState.STARTED, desiredState: SandboxDesiredState.STARTED, pending: false,
    runnerId: ownerId, storageBackend: SandboxStorageBackend.LOCAL,
    volumes: [{ volumeId: volume, mountPath: '/workspace', subpath: `sandboxes/${id}/workspace` }],
  } as Sandbox
  const repository = { findOneOrFail: jest.fn(async () => sandbox), hasIncompleteLifecycleJobs: jest.fn(async () => false) }
  const runner = { findOne: jest.fn(async () => ({ id: ownerId, apiUrl: 'http://runner.test', apiKey: 'test-key',
    state: RunnerState.READY, localVolumeEnabled: true, draining: false, unschedulable: false,
    serviceHealth: [{ serviceName: 'local-volume', healthy: true }] })) }
  const factory = { create: jest.fn() }
  const lock = { lock: jest.fn(async () => true), refreshOwned: jest.fn(async () => true), unlockOwned: jest.fn(async () => true) }
  const store = { hasActive: jest.fn(async () => false) }
  const service = new SandboxRebuildService(repository as never, runner as never, factory as never,
    { getSnapshotByName: async () => ({ name: 'old', ref: 'old-ref', sandboxClass: SandboxClass.CONTAINER }) } as never,
    { findInternalRegistryBySnapshotRef: async () => undefined } as never,
    {} as never, {} as never, {} as never, lock as never, store as never)
  return { sandbox, repository, factory, store, service }
}

describe('read-only rebuild eligibility', () => {
  afterEach(() => jest.restoreAllMocks())

  it('rejects destroyed/null-runner control plane without invoking Runner or compute actions', async () => {
    const f = fixture()
    Object.assign(f.sandbox, { state: SandboxState.DESTROYED, desiredState: SandboxDesiredState.DESTROYED, runnerId: null })
    const inspect = jest.spyOn(axios, 'post')
    await expect(f.service.getEligibility(id, org)).rejects.toMatchObject({ response: { code: 'control_plane_inconsistent' } })
    expect(inspect).not.toHaveBeenCalled()
    expect(f.factory.create).not.toHaveBeenCalled()
  })

  it('rejects unresolved jobs before runtime inspection', async () => {
    const f = fixture()
    f.repository.hasIncompleteLifecycleJobs.mockResolvedValue(true)
    const inspect = jest.spyOn(axios, 'post')
    await expect(f.service.getEligibility(id, org)).rejects.toMatchObject({ response: { code: 'remote_operation_unresolved' } })
    expect(inspect).not.toHaveBeenCalled()
  })

  it('only uses read-only mount inspection and rechecks identity after inspection', async () => {
    const f = fixture()
    jest.spyOn(axios, 'post').mockImplementation((async () => {
      f.sandbox.desiredState = SandboxDesiredState.DESTROYED
      return { data: { sandboxId: id, verified: true, image: 'old-ref', containerId: 'generation', created: '2026-10-23T08:46:17.612Z' } }
    }) as never)
    await expect(f.service.getEligibility(id, org)).rejects.toMatchObject({ response: { code: 'control_plane_inconsistent' } })
    expect(f.factory.create).not.toHaveBeenCalled()
  })
})
