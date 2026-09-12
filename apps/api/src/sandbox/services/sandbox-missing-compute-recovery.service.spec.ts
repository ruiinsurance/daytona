/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException } from '@nestjs/common'
import { Sandbox } from '../entities/sandbox.entity'
import { Volume } from '../entities/volume.entity'
import { RunnerApiError } from '../errors/runner-api-error'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { VolumeState } from '../enums/volume-state.enum'
import { buildRunnerVolumes } from '../local-volume/local-volume.contract'
import {
  SandboxMissingComputeRecoveryService,
  type RecoverMissingComputeInput,
} from './sandbox-missing-compute-recovery.service'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const operationId = '55555555-5555-4555-8555-555555555555'
const subpath = `sandboxes/${sandboxId}/workspace`

function input(overrides: Partial<RecoverMissingComputeInput> = {}): RecoverMissingComputeInput {
  return {
    operationId,
    ownerRunnerId,
    workspace: { volumeId, mountPath: '/workspace', subpath },
    ...overrides,
  }
}

function sandbox(): Sandbox {
  return {
    id: sandboxId,
    organizationId,
    name: 'sandbox-existing',
    runnerId: ownerRunnerId,
    prevRunnerId: ownerRunnerId,
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.ARCHIVED,
    desiredState: SandboxDesiredState.ARCHIVED,
    pending: false,
    snapshot: 'runtime-snapshot',
    sandboxClass: SandboxClass.CONTAINER,
    osUser: 'daytona',
    authToken: 'auth-token',
    env: { EXISTING_ENV: 'preserved' },
    cpu: 4,
    gpu: 0,
    mem: 8,
    disk: 50,
    region: 'local',
    volumes: [
      { volumeId, mountPath: '/workspace', subpath },
      { volumeId, mountPath: '/config', subpath },
    ],
  } as unknown as Sandbox
}

function ownerRunner() {
  return {
    id: ownerRunnerId,
    region: 'local',
    apiVersion: '0',
    state: RunnerState.READY,
    unschedulable: false,
    draining: false,
    localVolumeEnabled: true,
    serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
  }
}

function store() {
  return {
    get: jest.fn().mockResolvedValue(null),
    begin: jest.fn().mockResolvedValue(true),
    advance: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
    abort: jest.fn().mockResolvedValue(undefined),
  }
}

function createHarness(
  options: {
    sandboxInfo?: jest.Mock
    createError?: unknown
    completed?: boolean
    ownerApiVersion?: '0' | '2'
    v2WorkspaceMissing?: boolean
    volumeName?: string
  } = {},
) {
  const row = sandbox()
  const operationStore = store()
  if (options.completed) {
    operationStore.get.mockResolvedValue({
      status: 'complete',
      request: input(),
      result: {
        outcome: 'recovered',
        operationId,
        sandboxId,
        externalId: sandboxId,
        ownerRunnerId,
        status: 'running',
        computeCreated: true,
        workspace: input().workspace,
      },
    })
  }
  let runnerInfoCalls = 0
  const defaultSandboxInfo = jest.fn().mockImplementation(async () => {
    runnerInfoCalls += 1
    if (options.ownerApiVersion === '2') {
      if (runnerInfoCalls === 1) return { state: SandboxState.ARCHIVED }
      if (options.v2WorkspaceMissing) {
        Object.assign(row, {
          state: SandboxState.ERROR,
          desiredState: SandboxDesiredState.STARTED,
          pending: false,
        })
        return { state: SandboxState.ERROR, errorCode: 'LOCAL_WORKSPACE_MISSING' }
      }
      Object.assign(row, {
        state: SandboxState.STARTED,
        desiredState: SandboxDesiredState.STARTED,
        pending: false,
      })
      return { state: SandboxState.STARTED }
    }
    if (runnerInfoCalls === 1) throw new RunnerApiError('not found', 404, 'NOT_FOUND')
    return { state: SandboxState.STARTED }
  })
  const runnerAdapter = {
    snapshotExists: jest.fn().mockResolvedValue(true),
    sandboxInfo: options.sandboxInfo ?? defaultSandboxInfo,
    createSandbox: options.createError
      ? jest.fn().mockRejectedValue(options.createError)
      : jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
    startSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
  }
  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Sandbox) return row
      if (entity === Volume) {
        return {
          id: volumeId,
          organizationId,
          name: options.volumeName ?? volumeId,
          state: VolumeState.READY,
        }
      }
      return null
    }),
    insert: jest.fn(),
    update: jest.fn().mockImplementation(async (_entity, _criteria, patch) => {
      Object.assign(row, patch)
      return { affected: 1 }
    }),
  }
  const dataSource = { transaction: jest.fn(async (work) => work(manager)) }
  Object.assign(dataSource, { manager })
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    refreshOwned: jest.fn().mockResolvedValue(true),
    unlockOwned: jest.fn().mockResolvedValue(true),
  }
  const service = new SandboxMissingComputeRecoveryService(
    { findOneOrFail: jest.fn().mockResolvedValue(row) } as never,
    {
      findOne: jest.fn().mockResolvedValue({
        ...ownerRunner(),
        apiVersion: options.ownerApiVersion ?? '0',
      }),
    } as never,
    { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
    {
      getSnapshotByName: jest.fn().mockResolvedValue({
        ref: 'registry.example.com/runtime@sha256:abc',
        entrypoint: ['/usr/bin/start'],
        sandboxClass: SandboxClass.CONTAINER,
      }),
      getEntrypointFromDockerfile: jest.fn(),
    } as never,
    { findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue(undefined) } as never,
    { findOne: jest.fn().mockResolvedValue({ sandboxMetadata: { product: 'suna' } }) } as never,
    { pullSnapshotToRunner: jest.fn() } as never,
    { get: jest.fn().mockReturnValue('http://otel:4318') } as never,
    redisLockProvider as never,
    operationStore as never,
    dataSource as never,
  )
  return { service, row, runnerAdapter, manager, dataSource, operationStore, redisLockProvider }
}

describe('SandboxMissingComputeRecoveryService', () => {
  it('recreates only compute over the exact retained workspace and preserves every stable identity', async () => {
    const harness = createHarness()

    await expect(harness.service.recover(sandboxId, organizationId, input())).resolves.toEqual({
      outcome: 'recovered',
      operationId,
      sandboxId,
      externalId: sandboxId,
      ownerRunnerId,
      status: 'running',
      computeCreated: true,
      workspace: input().workspace,
    })

    expect(harness.runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: sandboxId, runnerId: ownerRunnerId, volumes: sandbox().volumes }),
      'registry.example.com/runtime@sha256:abc',
      undefined,
      ['/usr/bin/start'],
      expect.objectContaining({ sandboxName: 'sandbox-existing' }),
      'http://otel:4318',
      undefined,
      { requireExistingLocalWorkspace: true },
    )
    expect(harness.manager.insert).not.toHaveBeenCalled()
    expect(harness.row.volumes).toEqual(sandbox().volumes)
    expect(harness.row.runnerId).toBe(ownerRunnerId)
    expect(harness.row.state).toBe(SandboxState.STARTED)
    expect(harness.row.desiredState).toBe(SandboxDesiredState.STARTED)
    expect(harness.row.pending).toBe(false)
  })

  it('accepts the exact original shared local Volume when its display name differs from its UUID', async () => {
    const harness = createHarness({ volumeName: 'suna-user-data-v190' })

    await expect(harness.service.recover(sandboxId, organizationId, input())).resolves.toEqual(
      expect.objectContaining({
        outcome: 'recovered',
        sandboxId,
        ownerRunnerId,
        computeCreated: true,
        workspace: input().workspace,
      }),
    )
    expect(harness.runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: sandboxId, runnerId: ownerRunnerId }),
      expect.any(String),
      undefined,
      expect.any(Array),
      expect.any(Object),
      expect.any(String),
      undefined,
      { requireExistingLocalWorkspace: true },
    )
  })

  it('recovers missing compute after an ordinary start leaves the exact sandbox in error', async () => {
    const harness = createHarness({ volumeName: 'suna-user-data-v190' })
    Object.assign(harness.row, {
      state: SandboxState.ERROR,
      desiredState: SandboxDesiredState.STARTED,
      pending: false,
      errorReason: 'sandbox container not found',
      recoverable: false,
    })

    await expect(harness.service.recover(sandboxId, organizationId, input())).resolves.toEqual(
      expect.objectContaining({
        outcome: 'recovered',
        sandboxId,
        ownerRunnerId,
        computeCreated: true,
        workspace: input().workspace,
      }),
    )
    expect(harness.runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: sandboxId, runnerId: ownerRunnerId }),
      expect.any(String),
      undefined,
      expect.any(Array),
      expect.any(Object),
      expect.any(String),
      undefined,
      { requireExistingLocalWorkspace: true },
    )
    expect(harness.row).toMatchObject({
      state: SandboxState.STARTED,
      desiredState: SandboxDesiredState.STARTED,
      pending: false,
      errorReason: null,
      recoverable: false,
    })
  })

  it('does not recreate compute when an errored container still exists on the owner Runner', async () => {
    const harness = createHarness({
      volumeName: 'suna-user-data-v190',
      sandboxInfo: jest.fn().mockResolvedValue({ state: SandboxState.ERROR }),
    })
    Object.assign(harness.row, {
      state: SandboxState.ERROR,
      desiredState: SandboxDesiredState.STARTED,
      pending: false,
      errorReason: 'existing container failed',
    })

    await expect(harness.service.recover(sandboxId, organizationId, input())).rejects.toBeInstanceOf(ConflictException)
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.startSandbox).not.toHaveBeenCalled()
    expect(harness.operationStore.complete).not.toHaveBeenCalled()
  })

  it('replays a completed operation without database, Runner, or lock side effects', async () => {
    const harness = createHarness({ completed: true })

    await harness.service.recover(sandboxId, organizationId, input())

    expect(harness.redisLockProvider.lock).not.toHaveBeenCalled()
    expect(harness.dataSource.transaction).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('accepts an already-running exact container without recreating it', async () => {
    const harness = createHarness({ sandboxInfo: jest.fn().mockResolvedValue({ state: SandboxState.STARTED }) })

    await expect(harness.service.recover(sandboxId, organizationId, input())).resolves.toEqual(
      expect.objectContaining({ outcome: 'recovered', computeCreated: false, status: 'running' }),
    )
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.startSandbox).not.toHaveBeenCalled()
  })

  it('starts an exact stopped container without creating replacement compute', async () => {
    const harness = createHarness({
      sandboxInfo: jest
        .fn()
        .mockResolvedValueOnce({ state: SandboxState.STOPPED })
        .mockResolvedValueOnce({ state: SandboxState.STARTED }),
    })

    await expect(harness.service.recover(sandboxId, organizationId, input())).resolves.toEqual(
      expect.objectContaining({ outcome: 'recovered', computeCreated: false, status: 'running' }),
    )
    expect(harness.runnerAdapter.startSandbox).toHaveBeenCalledWith(sandboxId, 'auth-token', {
      volumes: JSON.stringify(buildRunnerVolumes(sandbox())),
    })
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('does not replace a stopped container when its retained workspace is missing', async () => {
    const harness = createHarness({ sandboxInfo: jest.fn().mockResolvedValue({ state: SandboxState.STOPPED }) })
    harness.runnerAdapter.startSandbox.mockRejectedValue(
      new RunnerApiError('The required Runner-local workspace is missing', 409, 'LOCAL_WORKSPACE_MISSING'),
    )

    const error = await harness.service.recover(sandboxId, organizationId, input()).catch((caught) => caught)

    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getResponse()).toEqual(expect.objectContaining({ code: 'workspace_missing', retryable: false }))
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    expect(harness.manager.update).not.toHaveBeenCalled()
  })

  it('uses the same fail-closed create job for a v2 Runner and waits for its real completion', async () => {
    const harness = createHarness({ ownerApiVersion: '2' })

    await expect(harness.service.recover(sandboxId, organizationId, input())).resolves.toEqual(
      expect.objectContaining({ outcome: 'recovered', status: 'running' }),
    )
    expect(harness.runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: sandboxId, runnerId: ownerRunnerId }),
      'registry.example.com/runtime@sha256:abc',
      undefined,
      ['/usr/bin/start'],
      expect.any(Object),
      'http://otel:4318',
      undefined,
      { requireExistingLocalWorkspace: true },
    )
    expect(harness.row.state).toBe(SandboxState.STARTED)
    expect(harness.row.pending).toBe(false)
  })

  it('restores the prior Daytona control state when a v2 job proves the workspace is missing', async () => {
    const harness = createHarness({ ownerApiVersion: '2', v2WorkspaceMissing: true })

    const error = await harness.service.recover(sandboxId, organizationId, input()).catch((caught) => caught)

    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getResponse()).toEqual(expect.objectContaining({ code: 'workspace_missing' }))
    expect(harness.row.state).toBe(SandboxState.ARCHIVED)
    expect(harness.row.desiredState).toBe(SandboxDesiredState.ARCHIVED)
    expect(harness.row.pending).toBe(false)
  })

  it('returns workspace_missing without changing Daytona state or creating an empty directory', async () => {
    const harness = createHarness({
      createError: new RunnerApiError('The required Runner-local workspace is missing', 409, 'LOCAL_WORKSPACE_MISSING'),
    })

    const error = await harness.service.recover(sandboxId, organizationId, input()).catch((caught) => caught)
    expect(error).toBeInstanceOf(ConflictException)
    expect(error.getResponse()).toEqual(expect.objectContaining({ code: 'workspace_missing', retryable: false }))
    expect(harness.manager.update).not.toHaveBeenCalled()
    expect(harness.operationStore.complete).not.toHaveBeenCalled()
  })

  it('rejects caller-substituted owner or Volume before touching the Runner', async () => {
    for (const request of [
      input({ ownerRunnerId: '66666666-6666-4666-8666-666666666666' }),
      input({ workspace: { ...input().workspace, volumeId: '77777777-7777-4777-8777-777777777777' } }),
    ]) {
      const harness = createHarness()
      await expect(harness.service.recover(sandboxId, organizationId, request)).rejects.toBeInstanceOf(
        ConflictException,
      )
      expect(harness.runnerAdapter.sandboxInfo).not.toHaveBeenCalled()
      expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    }
  })
})
