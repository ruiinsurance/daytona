/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Sandbox } from '../entities/sandbox.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { SandboxWorkspaceDestructionService } from './sandbox-workspace-destruction.service'
import { v5 as uuidv5 } from 'uuid'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const operationId = '55555555-5555-4555-8555-555555555555'
const subpath = `sandboxes/${sandboxId}/workspace`

function destroyedSandbox(): Sandbox {
  return {
    id: sandboxId,
    organizationId,
    runnerId: null,
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.DESTROYED,
    desiredState: SandboxDesiredState.DESTROYED,
    pending: false,
    volumes: [{ volumeId, mountPath: '/workspace', subpath }],
  } as Sandbox
}

function stoppedSandbox(): Sandbox {
  return {
    ...destroyedSandbox(),
    runnerId: ownerRunnerId,
    state: SandboxState.STOPPED,
    desiredState: SandboxDesiredState.STOPPED,
  } as Sandbox
}

function readyOwner() {
  return {
    id: ownerRunnerId,
    apiVersion: '2',
    state: RunnerState.READY,
    unschedulable: false,
    draining: false,
    serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
  }
}

function request() {
  return { operationId, ownerRunnerId, volumeId, subpath }
}

function operationStore() {
  return {
    get: jest.fn().mockResolvedValue(null),
    begin: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(undefined),
  }
}

function completedWorkspaceJob(jobId = uuidv5('destroy-workspace', operationId)) {
  return {
    id: jobId,
    type: JobType.DESTROY_SANDBOX_WORKSPACE,
    runnerId: ownerRunnerId,
    resourceType: ResourceType.SANDBOX,
    resourceId: sandboxId,
    status: JobStatus.COMPLETED,
    payload: JSON.stringify(request()),
    resultMetadata: JSON.stringify({
      operationId,
      sandboxId,
      ownerRunnerId,
      volumeId,
      subpath,
      outcome: 'removed',
    }),
  }
}

describe('SandboxWorkspaceDestructionService', () => {
  it('removes only the exact workspace slice after compute is already destroyed', async () => {
    const store = operationStore()
    const workspaceJob = completedWorkspaceJob()
    const jobService = {
      createJob: jest.fn().mockResolvedValue(workspaceJob),
      findOne: jest.fn().mockResolvedValue(workspaceJob),
    }
    const service = new SandboxWorkspaceDestructionService(
      {
        findOneOrFail: jest.fn().mockResolvedValue(destroyedSandbox()),
        updateWhere: jest.fn().mockResolvedValue(destroyedSandbox()),
      } as never,
      { findOne: jest.fn().mockResolvedValue(readyOwner()) } as never,
      jobService as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
      } as never,
      store as never,
    )

    await expect(service.destroy(sandboxId, organizationId, request())).resolves.toEqual({
      outcome: 'workspace_destroyed',
      operationId,
      sandboxId,
      ownerRunnerId,
      computeDestroyed: true,
      workspace: { volumeId, mountPath: '/workspace', subpath },
      removalOutcome: 'removed',
    })
    expect(jobService.createJob).toHaveBeenCalledWith(
      null,
      JobType.DESTROY_SANDBOX_WORKSPACE,
      ownerRunnerId,
      ResourceType.SANDBOX,
      sandboxId,
      request(),
      uuidv5('destroy-workspace', operationId),
    )
    expect(store.complete).toHaveBeenCalledTimes(1)
  })

  it('destroys stopped compute before removing its workspace slice', async () => {
    const computeJob = {
      id: uuidv5('destroy-compute', operationId),
      type: JobType.DESTROY_SANDBOX,
      runnerId: ownerRunnerId,
      resourceType: ResourceType.SANDBOX,
      resourceId: sandboxId,
      status: JobStatus.COMPLETED,
      payload: JSON.stringify(request()),
      resultMetadata: null,
    }
    const workspaceJob = completedWorkspaceJob()
    const jobService = {
      createJob: jest.fn().mockResolvedValueOnce(computeJob).mockResolvedValueOnce(workspaceJob),
      findOne: jest.fn(async (id: string) => (id === computeJob.id ? computeJob : workspaceJob)),
    }
    const service = new SandboxWorkspaceDestructionService(
      {
        findOneOrFail: jest.fn().mockResolvedValue(stoppedSandbox()),
        updateWhere: jest.fn().mockResolvedValue(destroyedSandbox()),
      } as never,
      { findOne: jest.fn().mockResolvedValue(readyOwner()) } as never,
      jobService as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
      } as never,
      operationStore() as never,
    )

    await service.destroy(sandboxId, organizationId, request())

    expect(jobService.createJob.mock.calls.map((call) => call[1])).toEqual([
      JobType.DESTROY_SANDBOX,
      JobType.DESTROY_SANDBOX_WORKSPACE,
    ])
  })

  it('rejects another sandbox subpath before any Runner mutation', async () => {
    const jobService = { createJob: jest.fn(), findOne: jest.fn() }
    const service = new SandboxWorkspaceDestructionService(
      { findOneOrFail: jest.fn().mockResolvedValue(destroyedSandbox()) } as never,
      { findOne: jest.fn().mockResolvedValue(readyOwner()) } as never,
      jobService as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
      } as never,
      operationStore() as never,
    )

    await expect(
      service.destroy(sandboxId, organizationId, {
        ...request(),
        subpath: 'sandboxes/88888888-8888-4888-8888-888888888888/workspace',
      }),
    ).rejects.toThrow('Invalid exact workspace destruction request')
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('replays a completed operation without another Runner mutation', async () => {
    const result = {
      outcome: 'workspace_destroyed' as const,
      operationId,
      sandboxId,
      ownerRunnerId,
      computeDestroyed: true as const,
      workspace: { volumeId, mountPath: '/workspace' as const, subpath },
      removalOutcome: 'already_absent' as const,
    }
    const store = operationStore()
    store.get.mockResolvedValue({ status: 'complete', ...request(), sandboxId, result })
    const jobService = { createJob: jest.fn() }
    const service = new SandboxWorkspaceDestructionService(
      { findOneOrFail: jest.fn().mockResolvedValue(destroyedSandbox()) } as never,
      {} as never,
      jobService as never,
      {} as never,
      store as never,
    )

    await expect(service.destroy(sandboxId, organizationId, request())).resolves.toEqual(result)
    expect(jobService.createJob).not.toHaveBeenCalled()
  })

  it('resumes a running operation from its deterministic completed Runner job', async () => {
    const workspaceJob = completedWorkspaceJob()
    const store = operationStore()
    store.get.mockResolvedValue({ status: 'running', ...request(), sandboxId })
    const jobService = {
      createJob: jest.fn(),
      findOne: jest.fn().mockResolvedValue(workspaceJob),
    }
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(destroyedSandbox()),
      updateWhere: jest.fn().mockResolvedValue(destroyedSandbox()),
    }
    const service = new SandboxWorkspaceDestructionService(
      sandboxRepository as never,
      { findOne: jest.fn().mockResolvedValue(readyOwner()) } as never,
      jobService as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
      } as never,
      store as never,
    )

    await expect(service.destroy(sandboxId, organizationId, request())).resolves.toMatchObject({
      outcome: 'workspace_destroyed',
      removalOutcome: 'removed',
    })
    expect(jobService.findOne).toHaveBeenCalledWith(uuidv5('destroy-workspace', operationId))
    expect(jobService.createJob).not.toHaveBeenCalled()
    expect(sandboxRepository.updateWhere).toHaveBeenCalledTimes(1)
    expect(store.complete).toHaveBeenCalledTimes(1)
  })

  it('returns in-progress when the original request still owns the state lock', async () => {
    const store = operationStore()
    store.get.mockResolvedValue({ status: 'running', ...request(), sandboxId })
    const service = new SandboxWorkspaceDestructionService(
      { findOneOrFail: jest.fn().mockResolvedValue(destroyedSandbox()) } as never,
      {} as never,
      { createJob: jest.fn() } as never,
      { lock: jest.fn().mockResolvedValue(false) } as never,
      store as never,
    )

    await expect(service.destroy(sandboxId, organizationId, request())).resolves.toEqual({
      outcome: 'operation_in_progress',
      operationId,
      sandboxId,
    })
  })
})
