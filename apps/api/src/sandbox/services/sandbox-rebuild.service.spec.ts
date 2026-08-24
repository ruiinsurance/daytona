/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { OwnerRunnerUnavailableError } from '../errors/owner-runner-unavailable.error'
import { LocalSandboxStorageIdentityError } from '../errors/local-sandbox-storage-identity.error'
import { RunnerApiError } from '../errors/runner-api-error'
import { Sandbox } from '../entities/sandbox.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { SandboxRebuildService } from './sandbox-rebuild.service'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const operationId = '55555555-5555-4555-8555-555555555555'

function localSandbox(): Sandbox {
  return {
    id: sandboxId,
    name: 'same-owner-rebuild',
    organizationId,
    runnerId: ownerRunnerId,
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.STARTED,
    desiredState: SandboxDesiredState.STARTED,
    pending: false,
    snapshot: 'previous-snapshot',
    sandboxClass: SandboxClass.CONTAINER,
    osUser: 'daytona',
    authToken: 'test-auth-token',
    env: { EXISTING_ENV: 'preserved' },
    cpu: 4,
    gpu: 0,
    mem: 8,
    disk: 50,
    region: 'local',
    volumes: [
      {
        volumeId,
        mountPath: '/workspace',
        subpath: `sandboxes/${sandboxId}/workspace`,
      },
    ],
  } as unknown as Sandbox
}

function emptyOperationStore() {
  return {
    get: jest.fn().mockResolvedValue(null),
    begin: jest.fn().mockResolvedValue(true),
    complete: jest.fn().mockResolvedValue(undefined),
  }
}

describe('SandboxRebuildService', () => {
  it('rejects an unavailable owner before any Runner or snapshot mutation', async () => {
    const sandbox = localSandbox()
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox),
    }
    const runnerService = {
      findOne: jest.fn().mockResolvedValue({
        id: ownerRunnerId,
        state: RunnerState.UNRESPONSIVE,
        unschedulable: false,
        draining: false,
        localVolumeEnabled: true,
        serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
      }),
    }
    const runnerAdapterFactory = { create: jest.fn() }
    const snapshotService = { getSnapshotByName: jest.fn() }
    const sandboxStartAction = { pullSnapshotToRunner: jest.fn() }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
      unlockOwned: jest.fn().mockResolvedValue(true),
      refreshOwned: jest.fn().mockResolvedValue(true),
    }

    const service = new SandboxRebuildService(
      sandboxRepository as never,
      runnerService as never,
      runnerAdapterFactory as never,
      snapshotService as never,
      {} as never,
      {} as never,
      sandboxStartAction as never,
      {} as never,
      redisLockProvider as never,
      emptyOperationStore() as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      }),
    ).rejects.toBeInstanceOf(OwnerRunnerUnavailableError)

    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(snapshotService.getSnapshotByName).not.toHaveBeenCalled()
    expect(sandboxStartAction.pullSnapshotToRunner).not.toHaveBeenCalled()
    expect(redisLockProvider.unlockOwned).toHaveBeenCalled()
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()
  })

  it('fails closed before destroy when the current local mounts cannot be proven', async () => {
    const sandbox = localSandbox()
    const runnerAdapter = {
      startSandbox: jest.fn().mockRejectedValue(new Error('host path /secret/provider/detail changed')),
      destroySandbox: jest.fn(),
      createSandbox: jest.fn(),
    }
    const snapshotService = { getSnapshotByName: jest.fn() }
    const service = new SandboxRebuildService(
      { findOneOrFail: jest.fn().mockResolvedValue(sandbox) } as never,
      {
        findOne: jest.fn().mockResolvedValue({
          id: ownerRunnerId,
          region: 'local',
          apiVersion: '0',
          state: RunnerState.READY,
          unschedulable: false,
          draining: false,
          localVolumeEnabled: true,
          serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
        }),
      } as never,
      { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
      snapshotService as never,
      {} as never,
      { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: {} }) } as never,
      {} as never,
      {} as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        unlock: jest.fn().mockResolvedValue(undefined),
        unlockOwned: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
      } as never,
      emptyOperationStore() as never,
    )

    let caught: unknown
    try {
      await service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(LocalSandboxStorageIdentityError)
    expect((caught as LocalSandboxStorageIdentityError).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      message: 'The sandbox local Volume or mount identity could not be verified',
      code: 'storage_identity_invalid',
    })
    expect(JSON.stringify((caught as LocalSandboxStorageIdentityError).getResponse())).not.toContain('provider/detail')
    expect(snapshotService.getSnapshotByName).not.toHaveBeenCalled()
    expect(runnerAdapter.destroySandbox).not.toHaveBeenCalled()
    expect(runnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('reports a proven preflight failure without destroying the usable previous sandbox', async () => {
    const sandbox = localSandbox()
    const owner = {
      id: ownerRunnerId,
      region: 'local',
      apiVersion: '0',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      localVolumeEnabled: false,
      serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    }
    const runnerAdapter = {
      startSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
      snapshotExists: jest.fn().mockResolvedValue(true),
      destroySandbox: jest.fn(),
      createSandbox: jest.fn(),
    }
    const previousSnapshot = {
      name: 'previous-snapshot',
      ref: 'registry.example.com/kortix/previous@sha256:def',
      sandboxClass: SandboxClass.CONTAINER,
    }
    const snapshotService = {
      getSnapshotByName: jest.fn(async (name: string) => {
        if (name === previousSnapshot.name) return previousSnapshot
        throw new Error('target snapshot pull failed with provider detail')
      }),
      getEntrypointFromDockerfile: jest.fn(),
    }
    const operationStore = emptyOperationStore()
    const service = new SandboxRebuildService(
      { findOneOrFail: jest.fn().mockResolvedValue(sandbox) } as never,
      { findOne: jest.fn().mockResolvedValue(owner) } as never,
      { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
      snapshotService as never,
      { findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue({ id: 'registry-id' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: {} }) } as never,
      { pullSnapshotToRunner: jest.fn() } as never,
      { get: jest.fn() } as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
      } as never,
      operationStore as never,
    )

    const result = await service.rebuild(sandboxId, organizationId, {
      operationId,
      targetSnapshot: 'target-snapshot',
    })
    expect(result).toEqual({
      outcome: 'rebuild_preflight_failed',
      operationId,
      sandboxId,
      ownerRunnerId,
      previousSnapshot: previousSnapshot.name,
      targetSnapshot: 'target-snapshot',
    })

    expect(runnerAdapter.startSandbox).toHaveBeenCalledTimes(1)
    expect(runnerAdapter.destroySandbox).not.toHaveBeenCalled()
    expect(runnerAdapter.createSandbox).not.toHaveBeenCalled()
    expect(operationStore.begin).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toContain('provider detail')
  })

  it('rebuilds the compute generation on the same owner and local Volume', async () => {
    const sandbox = localSandbox()
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox),
      updateWhere: jest.fn().mockImplementation(async (_id, input) => {
        Object.assign(sandbox, input.updateData)
        return sandbox
      }),
    }
    const owner = {
      id: ownerRunnerId,
      region: 'local',
      apiVersion: '0',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      localVolumeEnabled: true,
      serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    }
    const runnerService = { findOne: jest.fn().mockResolvedValue(owner) }
    const runnerAdapter = {
      startSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
      snapshotExists: jest.fn().mockResolvedValue(true),
      destroySandbox: jest.fn().mockResolvedValue(undefined),
      createSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
    }
    const runnerAdapterFactory = { create: jest.fn().mockResolvedValue(runnerAdapter) }
    const targetSnapshot = {
      name: 'target-snapshot',
      ref: 'registry.example.com/kortix/target@sha256:abc',
      entrypoint: ['/usr/bin/start'],
      sandboxClass: SandboxClass.CONTAINER,
    }
    const snapshotService = { getSnapshotByName: jest.fn().mockResolvedValue(targetSnapshot) }
    const dockerRegistryService = {
      findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue({ id: 'registry-id' }),
    }
    const organizationService = {
      findOne: jest.fn().mockResolvedValue({ sandboxMetadata: { deployment: 'test' } }),
    }
    const sandboxStartAction = { pullSnapshotToRunner: jest.fn() }
    const configService = { get: jest.fn().mockReturnValue('http://otel:4318') }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
      unlockOwned: jest.fn().mockResolvedValue(true),
      refreshOwned: jest.fn().mockResolvedValue(true),
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      runnerService as never,
      runnerAdapterFactory as never,
      snapshotService as never,
      dockerRegistryService as never,
      organizationService as never,
      sandboxStartAction as never,
      configService as never,
      redisLockProvider as never,
      emptyOperationStore() as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: targetSnapshot.name,
      }),
    ).resolves.toEqual({
      outcome: 'rebuilt',
      operationId,
      sandboxId,
      ownerRunnerId,
      previousSnapshot: 'previous-snapshot',
      targetSnapshot: targetSnapshot.name,
    })

    expect(runnerAdapter.startSandbox).toHaveBeenCalledTimes(2)
    expect(runnerAdapter.startSandbox).toHaveBeenNthCalledWith(
      1,
      sandboxId,
      sandbox.authToken,
      expect.objectContaining({
        volumes: expect.stringContaining(volumeId),
      }),
    )
    expect(runnerAdapter.destroySandbox).toHaveBeenCalledWith(sandboxId)
    expect(runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sandboxId,
        runnerId: ownerRunnerId,
        volumes: sandbox.volumes,
        env: {
          EXISTING_ENV: 'preserved',
          KORTIX_REBUILD_REQUIRED: 'true',
          KORTIX_REBUILD_OPERATION_ID: operationId,
        },
      }),
      targetSnapshot.ref,
      expect.objectContaining({ id: 'registry-id' }),
      targetSnapshot.entrypoint,
      expect.objectContaining({ sandboxName: sandbox.name }),
      'http://otel:4318',
    )
    expect(runnerAdapter.startSandbox.mock.invocationCallOrder[0]).toBeLessThan(
      runnerAdapter.destroySandbox.mock.invocationCallOrder[0],
    )
    expect(redisLockProvider.refreshOwned).toHaveBeenCalled()
    expect(redisLockProvider.refreshOwned.mock.invocationCallOrder[0]).toBeLessThan(
      runnerAdapter.destroySandbox.mock.invocationCallOrder[0],
    )
    expect(runnerAdapter.destroySandbox.mock.invocationCallOrder[0]).toBeLessThan(
      runnerAdapter.createSandbox.mock.invocationCallOrder[0],
    )
    expect(sandbox.runnerId).toBe(ownerRunnerId)
    expect(sandbox.volumes).toEqual(localSandbox().volumes)
    expect(sandbox.snapshot).toBe(targetSnapshot.name)
    expect(redisLockProvider.unlockOwned).toHaveBeenCalledWith(
      `sandbox:${sandboxId}:state-change`,
      expect.objectContaining({ getCode: expect.any(Function) }),
    )
    expect(redisLockProvider.unlock).not.toHaveBeenCalled()
  })

  it('does not roll back a ready target generation when recording the terminal result fails', async () => {
    const sandbox = localSandbox()
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox),
      updateWhere: jest.fn().mockImplementation(async (_id, input) => {
        Object.assign(sandbox, input.updateData)
        return sandbox
      }),
    }
    const owner = {
      id: ownerRunnerId,
      region: 'local',
      apiVersion: '0',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      localVolumeEnabled: true,
      serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    }
    const runnerAdapter = {
      startSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
      snapshotExists: jest.fn().mockResolvedValue(true),
      destroySandbox: jest.fn().mockResolvedValue(undefined),
      createSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
    }
    const previousSnapshot = {
      name: 'previous-snapshot',
      ref: 'registry.example.com/kortix/previous@sha256:def',
      sandboxClass: SandboxClass.CONTAINER,
    }
    const targetSnapshot = {
      name: 'target-snapshot',
      ref: 'registry.example.com/kortix/target@sha256:abc',
      sandboxClass: SandboxClass.CONTAINER,
    }
    const recordingError = new Error('operation result store unavailable')
    const operationStore = {
      get: jest.fn().mockResolvedValue(null),
      begin: jest.fn().mockResolvedValue(true),
      complete: jest.fn().mockRejectedValue(recordingError),
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      { findOne: jest.fn().mockResolvedValue(owner) } as never,
      { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
      {
        getSnapshotByName: jest.fn(async (name: string) =>
          name === previousSnapshot.name ? previousSnapshot : targetSnapshot,
        ),
      } as never,
      { findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue({ id: 'registry-id' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: {} }) } as never,
      { pullSnapshotToRunner: jest.fn() } as never,
      { get: jest.fn() } as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        unlockOwned: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
      } as never,
      operationStore as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: targetSnapshot.name,
      }),
    ).rejects.toBe(recordingError)

    expect(runnerAdapter.destroySandbox).toHaveBeenCalledTimes(1)
    expect(runnerAdapter.createSandbox).toHaveBeenCalledTimes(1)
    expect(runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: sandboxId, runnerId: ownerRunnerId }),
      targetSnapshot.ref,
      expect.anything(),
      undefined,
      expect.anything(),
      undefined,
    )
    expect(sandbox.snapshot).toBe(targetSnapshot.name)
    expect(sandbox.state).toBe(SandboxState.STARTED)
    expect(operationStore.complete).toHaveBeenCalledTimes(1)
  })

  it('restores the previous snapshot when target cleanup reports that no partial container exists', async () => {
    const sandbox = localSandbox()
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox),
      updateWhere: jest.fn(),
    }
    const owner = {
      id: ownerRunnerId,
      region: 'local',
      apiVersion: '0',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      localVolumeEnabled: true,
      serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    }
    const runnerService = { findOne: jest.fn().mockResolvedValue(owner) }
    const runnerAdapter = {
      startSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
      snapshotExists: jest.fn().mockResolvedValue(true),
      destroySandbox: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new RunnerApiError('Sandbox not found', 404)),
      createSandbox: jest
        .fn()
        .mockRejectedValueOnce(new Error('target image failed to start'))
        .mockResolvedValueOnce({ daemonVersion: 'restored' }),
    }
    const runnerAdapterFactory = { create: jest.fn().mockResolvedValue(runnerAdapter) }
    const previousSnapshot = {
      name: 'previous-snapshot',
      ref: 'registry.example.com/kortix/previous@sha256:def',
      entrypoint: ['/usr/bin/old-start'],
      sandboxClass: SandboxClass.CONTAINER,
    }
    const targetSnapshot = {
      name: 'target-snapshot',
      ref: 'registry.example.com/kortix/target@sha256:abc',
      entrypoint: ['/usr/bin/new-start'],
      sandboxClass: SandboxClass.CONTAINER,
    }
    const snapshotService = {
      getSnapshotByName: jest.fn(async (name: string) =>
        name === previousSnapshot.name ? previousSnapshot : targetSnapshot,
      ),
    }
    const registry = { id: 'registry-id' }
    const dockerRegistryService = {
      findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue(registry),
    }
    const organizationService = {
      findOne: jest.fn().mockResolvedValue({ sandboxMetadata: { deployment: 'test' } }),
    }
    const sandboxStartAction = { pullSnapshotToRunner: jest.fn() }
    const configService = { get: jest.fn().mockReturnValue('http://otel:4318') }
    const redisLockProvider = {
      lock: jest.fn().mockResolvedValue(true),
      unlock: jest.fn().mockResolvedValue(undefined),
      unlockOwned: jest.fn().mockResolvedValue(true),
      refreshOwned: jest.fn().mockResolvedValue(true),
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      runnerService as never,
      runnerAdapterFactory as never,
      snapshotService as never,
      dockerRegistryService as never,
      organizationService as never,
      sandboxStartAction as never,
      configService as never,
      redisLockProvider as never,
      emptyOperationStore() as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: targetSnapshot.name,
      }),
    ).resolves.toEqual({
      outcome: 'rebuild_failed_previous_restored',
      operationId,
      sandboxId,
      ownerRunnerId,
      previousSnapshot: previousSnapshot.name,
      targetSnapshot: targetSnapshot.name,
    })

    expect(runnerAdapter.destroySandbox).toHaveBeenCalledTimes(2)
    expect(runnerAdapter.createSandbox).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: sandboxId,
        runnerId: ownerRunnerId,
        volumes: sandbox.volumes,
        env: { EXISTING_ENV: 'preserved' },
      }),
      previousSnapshot.ref,
      registry,
      previousSnapshot.entrypoint,
      expect.objectContaining({ sandboxName: sandbox.name }),
      'http://otel:4318',
    )
    expect(sandboxRepository.updateWhere).not.toHaveBeenCalled()
    expect(sandbox.snapshot).toBe(previousSnapshot.name)
    expect(sandbox.runnerId).toBe(ownerRunnerId)
    expect(sandbox.volumes).toEqual(localSandbox().volumes)
  })

  it('preserves the local Volume and reports a hard failure when rollback also fails', async () => {
    const sandbox = localSandbox()
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox),
      updateWhere: jest.fn().mockImplementation(async (_id, input) => {
        Object.assign(sandbox, input.updateData)
        return sandbox
      }),
    }
    const owner = {
      id: ownerRunnerId,
      region: 'local',
      apiVersion: '0',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      localVolumeEnabled: true,
      serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    }
    const runnerAdapter = {
      startSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
      snapshotExists: jest.fn().mockResolvedValue(true),
      destroySandbox: jest.fn().mockResolvedValue(undefined),
      createSandbox: jest
        .fn()
        .mockRejectedValueOnce(new Error('target failed with provider detail'))
        .mockRejectedValueOnce(new Error('rollback failed with provider detail')),
    }
    const previousSnapshot = {
      name: 'previous-snapshot',
      ref: 'registry.example.com/kortix/previous@sha256:def',
      entrypoint: ['/usr/bin/old-start'],
      sandboxClass: SandboxClass.CONTAINER,
    }
    const targetSnapshot = {
      name: 'target-snapshot',
      ref: 'registry.example.com/kortix/target@sha256:abc',
      entrypoint: ['/usr/bin/new-start'],
      sandboxClass: SandboxClass.CONTAINER,
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      { findOne: jest.fn().mockResolvedValue(owner) } as never,
      { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
      {
        getSnapshotByName: jest.fn(async (name: string) =>
          name === previousSnapshot.name ? previousSnapshot : targetSnapshot,
        ),
      } as never,
      { findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue({ id: 'registry-id' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: {} }) } as never,
      { pullSnapshotToRunner: jest.fn() } as never,
      { get: jest.fn().mockReturnValue('http://otel:4318') } as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        unlock: jest.fn().mockResolvedValue(undefined),
        unlockOwned: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
      } as never,
      emptyOperationStore() as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: targetSnapshot.name,
      }),
    ).resolves.toEqual({
      outcome: 'rebuild_failed_rollback_failed',
      operationId,
      sandboxId,
      ownerRunnerId,
      previousSnapshot: previousSnapshot.name,
      targetSnapshot: targetSnapshot.name,
    })

    expect(sandboxRepository.updateWhere).toHaveBeenCalledWith(sandboxId, {
      updateData: {
        state: SandboxState.ERROR,
        errorReason: 'Local sandbox rebuild and rollback failed; workspace Volume was preserved',
        recoverable: true,
      },
      whereCondition: {
        state: SandboxState.STARTED,
        desiredState: SandboxDesiredState.STARTED,
        pending: false,
        runnerId: ownerRunnerId,
      },
    })
    expect(sandbox.snapshot).toBe(previousSnapshot.name)
    expect(sandbox.runnerId).toBe(ownerRunnerId)
    expect(sandbox.volumes).toEqual(localSandbox().volumes)
    expect(JSON.stringify(sandbox)).not.toContain('provider detail')
  })

  it('replays a completed operation without repeating provider mutation', async () => {
    const completedResult = {
      outcome: 'rebuilt' as const,
      operationId,
      sandboxId,
      ownerRunnerId,
      previousSnapshot: 'previous-snapshot',
      targetSnapshot: 'target-snapshot',
    }
    const sandboxRepository = { findOneOrFail: jest.fn() }
    const runnerAdapterFactory = { create: jest.fn() }
    const redisLockProvider = { lock: jest.fn(), unlock: jest.fn() }
    const operationStore = {
      get: jest.fn().mockResolvedValue({
        status: 'complete',
        targetSnapshot: 'target-snapshot',
        result: completedResult,
      }),
      begin: jest.fn(),
      complete: jest.fn(),
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      {} as never,
      runnerAdapterFactory as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      operationStore as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      }),
    ).resolves.toEqual(completedResult)

    expect(sandboxRepository.findOneOrFail).not.toHaveBeenCalled()
    expect(redisLockProvider.lock).not.toHaveBeenCalled()
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(operationStore.begin).not.toHaveBeenCalled()
    expect(operationStore.complete).not.toHaveBeenCalled()
  })

  it('reports an operation as in progress while its sandbox mutation lock is still held', async () => {
    const sandboxRepository = { findOneOrFail: jest.fn() }
    const runnerAdapterFactory = { create: jest.fn() }
    const redisLockProvider = {
      isLocked: jest.fn().mockResolvedValue(true),
      lock: jest.fn(),
    }
    const operationStore = {
      get: jest.fn().mockResolvedValue({
        status: 'running',
        operationId,
        sandboxId,
        targetSnapshot: 'target-snapshot',
      }),
      begin: jest.fn(),
      complete: jest.fn(),
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      {} as never,
      runnerAdapterFactory as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      operationStore as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      }),
    ).resolves.toEqual({
      outcome: 'operation_in_progress',
      operationId,
      sandboxId,
      targetSnapshot: 'target-snapshot',
    })

    expect(redisLockProvider.isLocked).toHaveBeenCalledWith(`sandbox:${sandboxId}:state-change`)
    expect(redisLockProvider.lock).not.toHaveBeenCalled()
    expect(sandboxRepository.findOneOrFail).not.toHaveBeenCalled()
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
  })

  it('reports an unknown outcome when a running operation outlives its sandbox mutation lock', async () => {
    const sandboxRepository = { findOneOrFail: jest.fn() }
    const runnerAdapterFactory = { create: jest.fn() }
    const redisLockProvider = {
      isLocked: jest.fn().mockResolvedValue(false),
      lock: jest.fn(),
    }
    const operationStore = {
      get: jest.fn().mockResolvedValue({
        status: 'running',
        operationId,
        sandboxId,
        targetSnapshot: 'target-snapshot',
      }),
      begin: jest.fn(),
      complete: jest.fn(),
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      {} as never,
      runnerAdapterFactory as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      redisLockProvider as never,
      operationStore as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      }),
    ).resolves.toEqual({
      outcome: 'operation_outcome_unknown',
      operationId,
      sandboxId,
      targetSnapshot: 'target-snapshot',
    })

    expect(redisLockProvider.isLocked).toHaveBeenCalledWith(`sandbox:${sandboxId}:state-change`)
    expect(redisLockProvider.lock).not.toHaveBeenCalled()
    expect(sandboxRepository.findOneOrFail).not.toHaveBeenCalled()
    expect(runnerAdapterFactory.create).not.toHaveBeenCalled()
  })

  it('waits for every asynchronous V2 Runner transition before reporting success', async () => {
    const sandbox = localSandbox()
    const sandboxRepository = {
      findOneOrFail: jest.fn().mockResolvedValue(sandbox),
      updateWhere: jest.fn().mockImplementation(async (_id, input) => {
        Object.assign(sandbox, input.updateData)
        return sandbox
      }),
    }
    const owner = {
      id: ownerRunnerId,
      region: 'local',
      apiVersion: '2',
      state: RunnerState.READY,
      unschedulable: false,
      draining: false,
      localVolumeEnabled: true,
      serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    }
    const runnerAdapter = {
      startSandbox: jest.fn().mockResolvedValue(undefined),
      snapshotExists: jest.fn().mockResolvedValue(true),
      destroySandbox: jest.fn().mockResolvedValue(undefined),
      createSandbox: jest.fn().mockResolvedValue(undefined),
      sandboxInfo: jest
        .fn()
        .mockResolvedValueOnce({ state: SandboxState.STARTED })
        .mockResolvedValueOnce({ state: SandboxState.DESTROYED })
        .mockResolvedValueOnce({ state: SandboxState.STARTED })
        .mockResolvedValueOnce({ state: SandboxState.STARTED }),
    }
    const targetSnapshot = {
      name: 'target-snapshot',
      ref: 'registry.example.com/kortix/target@sha256:abc',
      entrypoint: ['/usr/bin/start'],
      sandboxClass: SandboxClass.CONTAINER,
    }
    const service = new SandboxRebuildService(
      sandboxRepository as never,
      { findOne: jest.fn().mockResolvedValue(owner) } as never,
      { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
      { getSnapshotByName: jest.fn().mockResolvedValue(targetSnapshot) } as never,
      { findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue({ id: 'registry-id' }) } as never,
      { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: {} }) } as never,
      { pullSnapshotToRunner: jest.fn() } as never,
      { get: jest.fn() } as never,
      {
        lock: jest.fn().mockResolvedValue(true),
        unlock: jest.fn().mockResolvedValue(undefined),
        unlockOwned: jest.fn().mockResolvedValue(true),
        refreshOwned: jest.fn().mockResolvedValue(true),
      } as never,
      emptyOperationStore() as never,
    )

    await expect(
      service.rebuild(sandboxId, organizationId, {
        operationId,
        targetSnapshot: targetSnapshot.name,
      }),
    ).resolves.toMatchObject({ outcome: 'rebuilt', ownerRunnerId })

    expect(runnerAdapter.sandboxInfo).toHaveBeenCalledTimes(4)
    expect(runnerAdapter.destroySandbox.mock.invocationCallOrder[0]).toBeLessThan(
      runnerAdapter.sandboxInfo.mock.invocationCallOrder[1],
    )
    expect(runnerAdapter.sandboxInfo.mock.invocationCallOrder[1]).toBeLessThan(
      runnerAdapter.createSandbox.mock.invocationCallOrder[0],
    )
  })
})
