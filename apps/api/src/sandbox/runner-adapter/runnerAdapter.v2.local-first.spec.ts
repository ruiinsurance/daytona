import { RunnerAdapterV2 } from './runnerAdapter.v2'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { StorageNodeState } from '../enums/storage-node-state.enum'

const RUNNER_ID = '11111111-1111-4111-8111-111111111111'
const NODE_ID = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'
const VOLUME_ID = '44444444-4444-4444-8444-444444444444'
const SUBPATH = `sandboxes/${SANDBOX_ID}/workspace`

function sandbox() {
  return {
    id: SANDBOX_ID,
    name: 'local-first-test',
    state: SandboxState.STOPPED,
    organizationId: '55555555-5555-4555-8555-555555555555',
    region: 'region-test',
    osUser: 'daytona',
    cpu: 2,
    gpu: 0,
    mem: 4,
    disk: 10,
    env: {},
    volumes: [
      { volumeId: VOLUME_ID, mountPath: '/workspace', subpath: SUBPATH },
      { volumeId: VOLUME_ID, mountPath: '/config', subpath: SUBPATH },
    ],
    networkBlockAll: false,
    networkAllowList: undefined,
    domainAllowList: undefined,
    authToken: 'sandbox-auth-token',
    sandboxClass: 'container',
    linkedSandboxId: null,
  }
}

function createAdapter() {
  const jobService = {
    createJob: jest.fn().mockResolvedValue(undefined),
    findOne: jest.fn(),
  }
  const jobRepository = { findOne: jest.fn() }
  const sandboxRepository = { findOne: jest.fn().mockResolvedValue(sandbox()) }
  const storageNodeService = {
    findByRunnerId: jest.fn().mockResolvedValue({
      nodeId: NODE_ID,
      runnerId: RUNNER_ID,
      state: StorageNodeState.ACTIVE,
    }),
  }
  const workspacePlacementService = {
    findBySandboxId: jest.fn().mockResolvedValue(null),
    ensurePlacement: jest.fn().mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      ownerNodeId: NODE_ID,
      fenceEpoch: '1',
    }),
    acquireWriterLease: jest.fn().mockResolvedValue({
      fenceEpoch: '1',
      leaseOwner: `runner:${RUNNER_ID}:sandbox:${SANDBOX_ID}`,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    }),
    assertStartAllowed: jest.fn().mockResolvedValue(undefined),
  }
  const adapter = new RunnerAdapterV2(
    sandboxRepository as any,
    jobRepository as any,
    jobService as any,
    storageNodeService as any,
    workspacePlacementService as any,
  )
  return { adapter, jobService, jobRepository, sandboxRepository, storageNodeService, workspacePlacementService }
}

describe('RunnerAdapterV2 local-first storage', () => {
  it('acquires placement lease before adding local node/fence evidence to both aliases', async () => {
    const { adapter, jobService, workspacePlacementService } = createAdapter()
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    await adapter.createSandbox(sandbox() as any, 'snapshot-test', undefined, undefined, {
      storageBackend: 'local-first',
    })

    const payload = jobService.createJob.mock.calls[0][5]
    expect(workspacePlacementService.ensurePlacement).toHaveBeenCalledWith(
      expect.objectContaining({
        volumeId: VOLUME_ID,
        subpath: SUBPATH,
        sandboxId: SANDBOX_ID,
        ownerNodeId: NODE_ID,
      }),
    )
    expect(workspacePlacementService.acquireWriterLease).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        fenceEpoch: 1,
      }),
    )
    expect(workspacePlacementService.assertStartAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
      }),
    )
    expect(payload.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mountPath: '/workspace',
          backend: 'local-first',
          nodeId: NODE_ID,
          fenceEpoch: '1',
        }),
        expect.objectContaining({
          mountPath: '/config',
          backend: 'local-first',
          nodeId: NODE_ID,
          fenceEpoch: '1',
        }),
      ]),
    )
  })

  it('keeps the legacy payload unchanged when local-first is not requested', async () => {
    const { adapter, jobService, workspacePlacementService } = createAdapter()
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    await adapter.createSandbox(sandbox() as any, 'snapshot-test')

    const payload = jobService.createJob.mock.calls[0][5]
    expect(payload.volumes).toEqual([
      { volumeId: VOLUME_ID, mountPath: '/workspace', subpath: SUBPATH },
      { volumeId: VOLUME_ID, mountPath: '/config', subpath: SUBPATH },
    ])
    expect(workspacePlacementService.ensurePlacement).not.toHaveBeenCalled()
  })

  it('blocks a local-first start before acquiring a writer lease when recovery is required', async () => {
    const { adapter, jobService, workspacePlacementService } = createAdapter()
    workspacePlacementService.assertStartAllowed.mockRejectedValue(new Error('recovery_required'))
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    await expect(
      adapter.startSandbox(SANDBOX_ID, 'sandbox-auth-token', {
        storageBackend: 'local-first',
      }),
    ).rejects.toThrow('recovery_required')

    expect(workspacePlacementService.acquireWriterLease).not.toHaveBeenCalled()
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('checks an existing placement before ensurePlacement on a replacement runner', async () => {
    const { adapter, jobService, workspacePlacementService } = createAdapter()
    workspacePlacementService.findBySandboxId.mockResolvedValue({
      ownerNodeId: '77777777-7777-4777-8777-777777777777',
      localGeneration: '8',
      cosGeneration: '7',
    })
    workspacePlacementService.assertStartAllowed.mockRejectedValue(new Error('recovery_required'))
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    await expect(
      adapter.startSandbox(SANDBOX_ID, 'sandbox-auth-token', {
        storageBackend: 'local-first',
      }),
    ).rejects.toThrow('recovery_required')

    expect(workspacePlacementService.ensurePlacement).not.toHaveBeenCalled()
    expect(workspacePlacementService.acquireWriterLease).not.toHaveBeenCalled()
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('starts an owner-local workspace after a COS-lagged local checkpoint gate succeeds', async () => {
    const { adapter, jobService, workspacePlacementService } = createAdapter()
    workspacePlacementService.findBySandboxId.mockResolvedValue({
      ownerNodeId: NODE_ID,
      localGeneration: '8',
      cosGeneration: '7',
      fenceEpoch: '3',
    })
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    await adapter.startSandbox(SANDBOX_ID, 'sandbox-auth-token', {
      storageBackend: 'local-first',
    })

    const [, jobType, runnerId, , sandboxId, payload] = jobService.createJob.mock.calls[0]
    expect(jobType).toBe(JobType.START_SANDBOX)
    expect(runnerId).toBe(RUNNER_ID)
    expect(sandboxId).toBe(SANDBOX_ID)
    expect(workspacePlacementService.assertStartAllowed).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        placement: expect.objectContaining({ localGeneration: '8', cosGeneration: '7' }),
      }),
    )
    expect(workspacePlacementService.acquireWriterLease).toHaveBeenCalled()

    const volumes = JSON.parse(payload.metadata.volumes)
    expect(volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mountPath: '/workspace',
          backend: 'local-first',
          nodeId: NODE_ID,
          fenceEpoch: '1',
        }),
        expect.objectContaining({
          mountPath: '/config',
          backend: 'local-first',
          nodeId: NODE_ID,
          fenceEpoch: '1',
        }),
      ]),
    )
  })

  it('prepares a stopped target with target fence evidence without acquiring a writer lease', async () => {
    const { adapter, jobService, workspacePlacementService } = createAdapter()
    const targetNodeId = '77777777-7777-4777-8777-777777777777'
    jobService.createJob.mockResolvedValue({ id: '88888888-8888-4888-8888-888888888888' })
    jobService.findOne.mockResolvedValue({ status: 'COMPLETED' })
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    await adapter.prepareSandbox(
      sandbox() as any,
      'snapshot-test',
      undefined,
      undefined,
      { storageBackend: 'local-first' },
      undefined,
      {
        volumeId: VOLUME_ID,
        nodeId: targetNodeId,
        fenceEpoch: '4',
        leaseOwner: 'move-worker:test',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    )

    const payload = jobService.createJob.mock.calls[0][5]
    expect(payload).toMatchObject({ moveTargetPreparation: true, skipStart: true })
    expect(payload.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mountPath: '/workspace',
          backend: 'local-first',
          nodeId: targetNodeId,
          fenceEpoch: '4',
          leaseOwner: 'move-worker:test',
        }),
        expect.objectContaining({
          mountPath: '/config',
          backend: 'local-first',
          nodeId: targetNodeId,
          fenceEpoch: '4',
          leaseOwner: 'move-worker:test',
        }),
      ]),
    )
    expect(workspacePlacementService.ensurePlacement).not.toHaveBeenCalled()
    expect(workspacePlacementService.acquireWriterLease).not.toHaveBeenCalled()
    expect(workspacePlacementService.assertStartAllowed).not.toHaveBeenCalled()
  })

  it('does not infer a source start from a completed move-target CREATE job', async () => {
    const { adapter, jobRepository } = createAdapter()
    const moveTargetJob = {
      type: JobType.CREATE_SANDBOX,
      status: JobStatus.COMPLETED,
      getPayload: jest.fn().mockReturnValue({ moveTargetPreparation: true }),
      getResultMetadata: jest.fn().mockReturnValue(undefined),
    }
    jobRepository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(moveTargetJob)
    await adapter.init({ id: RUNNER_ID, apiVersion: '2' } as any)

    const info = await adapter.sandboxInfo(SANDBOX_ID)

    expect(info.state).toBe(SandboxState.STOPPED)
    expect(moveTargetJob.getPayload).toHaveBeenCalled()
  })
})
