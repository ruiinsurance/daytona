/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox } from '../entities/sandbox.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { SandboxWorkspaceRecoveryService } from './sandbox-workspace-recovery.service'
import { v5 as uuidv5 } from 'uuid'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const originalVolumeId = '44444444-4444-4444-8444-444444444444'
const replacementVolumeId = '55555555-5555-4555-8555-555555555555'
const operationId = '66666666-6666-4666-8666-666666666666'
const subpath = `sandboxes/${sandboxId}/workspace`

function sandbox(): Sandbox {
  return {
    id: sandboxId,
    name: 'destroyed-recovery-target',
    organizationId,
    runnerId: null,
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.DESTROYED,
    desiredState: SandboxDesiredState.DESTROYED,
    pending: false,
    snapshot: 'sandbox-snapshot',
    buildInfo: {
      snapshotRef: 'registry.test/sandbox@sha256:abc',
      dockerfileContent: 'FROM sandbox',
    },
    sandboxClass: SandboxClass.CONTAINER,
    osUser: 'daytona',
    authToken: 'sandbox-token',
    env: { PRESERVED: 'true' },
    cpu: 4,
    gpu: 0,
    mem: 8,
    disk: 50,
    region: 'local',
    volumes: [{ volumeId: originalVolumeId, mountPath: '/workspace', subpath }],
  } as unknown as Sandbox
}

const input = {
  operationId,
  ownerRunnerId,
  workspace: { volumeId: replacementVolumeId, mountPath: '/workspace' as const, subpath },
}

function operationStore() {
  return {
    get: jest.fn().mockResolvedValue(null),
    begin: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(undefined),
  }
}

describe('SandboxWorkspaceRecoveryService', () => {
  it('recovers stable sandbox identity on the exact owner and replacement workspace', async () => {
    const completedJob = {
      id: uuidv5('recover-workspace', operationId),
      type: JobType.RECOVER_SANDBOX_WORKSPACE,
      runnerId: ownerRunnerId,
      resourceType: ResourceType.SANDBOX,
      resourceId: sandboxId,
      status: JobStatus.COMPLETED,
      resultMetadata: JSON.stringify({
        operationId,
        sandboxId,
        ownerRunnerId,
        status: 'running',
        daemonVersion: 'test-daemon',
      }),
    }
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox()),
      updateWhere: jest.fn().mockImplementation(async (_id, update) => ({ ...sandbox(), ...update.updateData })),
    }
    const jobService = {
      createJob: jest.fn().mockImplementation(async (...args) => ({
        ...completedJob,
        payload: JSON.stringify(args[5]),
      })),
      findOne: jest.fn().mockResolvedValue(completedJob),
    }
    const store = operationStore()
    const service = new SandboxWorkspaceRecoveryService(
      sandboxRepository as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: ownerRunnerId,
          apiVersion: '2',
          region: 'local',
          state: RunnerState.READY,
          unschedulable: false,
          draining: false,
          serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
        }),
      } as never,
      { getEntrypointFromDockerfile: jest.fn().mockReturnValue(['/entrypoint']) } as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: { PRESERVED_METADATA: 'true' } }) } as never,
      { get: jest.fn().mockReturnValue('http://otel.test') } as never,
      { registerRestoredLocalVolume: jest.fn().mockResolvedValue({ id: replacementVolumeId }) } as never,
      jobService as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
      } as never,
      store as never,
    )

    await expect(service.recover(sandboxId, organizationId, input)).resolves.toEqual({
      outcome: 'recovered',
      operationId,
      sandboxId,
      externalId: sandboxId,
      ownerRunnerId,
      status: 'running',
      workspace: input.workspace,
    })

    const jobPayload = jobService.createJob.mock.calls[0][5]
    expect(jobService.createJob.mock.calls[0].slice(0, 5)).toEqual([
      null,
      JobType.RECOVER_SANDBOX_WORKSPACE,
      ownerRunnerId,
      ResourceType.SANDBOX,
      sandboxId,
    ])
    expect(jobPayload).toMatchObject({
      operationId,
      ownerRunnerId,
      originalVolumeId,
      originalVolumeSubpath: subpath,
      sandbox: {
        id: sandboxId,
        volumes: [
          { volumeId: replacementVolumeId, mountPath: '/workspace', subpath },
          { volumeId: replacementVolumeId, mountPath: '/config', subpath },
        ],
      },
    })
    expect(sandboxRepository.updateWhere).toHaveBeenCalledWith(
      sandboxId,
      expect.objectContaining({
        updateData: expect.objectContaining({
          state: SandboxState.STARTED,
          desiredState: SandboxDesiredState.STARTED,
          runnerId: ownerRunnerId,
          volumes: [
            { volumeId: replacementVolumeId, mountPath: '/workspace', subpath },
            { volumeId: replacementVolumeId, mountPath: '/config', subpath },
          ],
        }),
      }),
    )
    expect(store.complete).toHaveBeenCalledTimes(1)
  })

  it('rejects a replacement subpath belonging to another sandbox before mutation', async () => {
    const jobService = { createJob: jest.fn() }
    const service = new SandboxWorkspaceRecoveryService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      jobService as never,
      {} as never,
      operationStore() as never,
    )

    await expect(
      service.recover(sandboxId, organizationId, {
        ...input,
        workspace: {
          ...input.workspace,
          subpath: 'sandboxes/88888888-8888-4888-8888-888888888888/workspace',
        },
      }),
    ).rejects.toThrow('Invalid exact workspace recovery request')
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('replays a completed recovery after the sandbox is already running', async () => {
    const result = {
      outcome: 'recovered' as const,
      operationId,
      sandboxId,
      externalId: sandboxId,
      ownerRunnerId,
      status: 'running' as const,
      workspace: input.workspace,
    }
    const recovered = {
      ...sandbox(),
      state: SandboxState.STARTED,
      desiredState: SandboxDesiredState.STARTED,
      runnerId: ownerRunnerId,
      volumes: [
        { volumeId: replacementVolumeId, mountPath: '/workspace', subpath },
        { volumeId: replacementVolumeId, mountPath: '/config', subpath },
      ],
    } as Sandbox
    const store = operationStore()
    store.get.mockResolvedValue({ status: 'complete', sandboxId, ...input, result })
    const jobService = { createJob: jest.fn() }
    const service = new SandboxWorkspaceRecoveryService(
      { findOneOrFail: jest.fn().mockResolvedValue(recovered) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      jobService as never,
      {} as never,
      store as never,
    )

    await expect(service.recover(sandboxId, organizationId, input)).resolves.toEqual(result)
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('completes a running operation after activation survived an API interruption', async () => {
    const recovered = {
      ...sandbox(),
      state: SandboxState.STARTED,
      desiredState: SandboxDesiredState.STARTED,
      runnerId: ownerRunnerId,
      volumes: [
        { volumeId: replacementVolumeId, mountPath: '/workspace', subpath },
        { volumeId: replacementVolumeId, mountPath: '/config', subpath },
      ],
    } as Sandbox
    const store = operationStore()
    store.get.mockResolvedValue({ status: 'running', sandboxId, ...input })
    const volumeService = { registerRestoredLocalVolume: jest.fn().mockResolvedValue({ id: replacementVolumeId }) }
    const jobService = { createJob: jest.fn(), findOne: jest.fn() }
    const service = new SandboxWorkspaceRecoveryService(
      { findOneOrFail: jest.fn().mockResolvedValue(recovered) } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      volumeService as never,
      jobService as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
      } as never,
      store as never,
    )

    await expect(service.recover(sandboxId, organizationId, input)).resolves.toMatchObject({
      outcome: 'recovered',
      sandboxId,
      ownerRunnerId,
    })
    expect(volumeService.registerRestoredLocalVolume).toHaveBeenCalledWith(replacementVolumeId, organizationId)
    expect(jobService.createJob).not.toHaveBeenCalled()
    expect(jobService.findOne).not.toHaveBeenCalled()
    expect(store.complete).toHaveBeenCalledTimes(1)
  })
})
