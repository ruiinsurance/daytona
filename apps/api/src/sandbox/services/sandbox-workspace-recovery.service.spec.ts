/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { Sandbox } from '../entities/sandbox.entity'
import { Volume } from '../entities/volume.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { VolumeState } from '../enums/volume-state.enum'
import {
  SandboxWorkspaceRecoveryService,
  type RecoverSandboxWorkspaceInput,
  type RecoveredSandboxWorkspaceResult,
} from './sandbox-workspace-recovery.service'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const previousVolumeId = '44444444-4444-4444-8444-444444444444'
const replacementVolumeId = '55555555-5555-4555-8555-555555555555'
const operationId = '66666666-6666-4666-8666-666666666666'
const subpath = `sandboxes/${sandboxId}/workspace`

function recoveryInput(overrides: Partial<RecoverSandboxWorkspaceInput> = {}): RecoverSandboxWorkspaceInput {
  return {
    operationId,
    ownerRunnerId,
    workspace: {
      volumeId: replacementVolumeId,
      mountPath: '/workspace',
      subpath,
    },
    ...overrides,
  }
}

function destroyedSandbox(): Sandbox {
  return {
    id: sandboxId,
    name: `DESTROYED_workspace_1`,
    organizationId,
    runnerId: null,
    prevRunnerId: ownerRunnerId,
    storageBackend: SandboxStorageBackend.LOCAL,
    state: SandboxState.DESTROYED,
    desiredState: SandboxDesiredState.DESTROYED,
    pending: false,
    snapshot: 'runtime-snapshot',
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
      { volumeId: previousVolumeId, mountPath: '/workspace', subpath },
      { volumeId: previousVolumeId, mountPath: '/config', subpath },
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

function expectedResult(): RecoveredSandboxWorkspaceResult {
  return {
    outcome: 'recovered',
    operationId,
    sandboxId,
    externalId: sandboxId,
    ownerRunnerId,
    status: 'running',
    workspace: {
      volumeId: replacementVolumeId,
      mountPath: '/workspace',
      subpath,
    },
  }
}

function operationStore() {
  return {
    get: jest.fn().mockResolvedValue(null),
    begin: jest.fn().mockResolvedValue(true),
    advance: jest.fn().mockResolvedValue(undefined),
    complete: jest.fn().mockResolvedValue(undefined),
  }
}

function createTransaction(sandbox: Sandbox, volume: Volume | null = null) {
  const manager = {
    findOne: jest.fn(async (entity: unknown) => {
      if (entity === Sandbox) return sandbox
      if (entity === Volume) return volume
      return null
    }),
    insert: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockImplementation(async (entity: unknown, _criteria: unknown, update: Partial<Sandbox>) => {
      if (entity === Sandbox) Object.assign(sandbox, update)
      return { affected: 1 }
    }),
  }
  const dataSource = {
    transaction: jest.fn(async (work: (value: typeof manager) => Promise<unknown>) => work(manager)),
  }
  return { dataSource, manager }
}

function createHarness(
  options: {
    sandbox?: Sandbox
    volume?: Volume | null
    store?: ReturnType<typeof operationStore>
    sandboxInfo?: jest.Mock
  } = {},
) {
  const sandbox = options.sandbox ?? destroyedSandbox()
  const { dataSource, manager } = createTransaction(sandbox, options.volume)
  const store = options.store ?? operationStore()
  const runnerAdapter = {
    snapshotExists: jest.fn().mockResolvedValue(true),
    sandboxInfo:
      options.sandboxInfo ??
      jest
        .fn()
        .mockResolvedValueOnce({ state: SandboxState.DESTROYED })
        .mockResolvedValue({ state: SandboxState.STARTED }),
    createSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
  }
  const redisLockProvider = {
    lock: jest.fn().mockResolvedValue(true),
    refreshOwned: jest.fn().mockResolvedValue(true),
    unlockOwned: jest.fn().mockResolvedValue(true),
  }
  const runnerService = { findOne: jest.fn().mockResolvedValue(ownerRunner()) }
  const service = new SandboxWorkspaceRecoveryService(
    { findOneOrFail: jest.fn().mockResolvedValue(sandbox) } as never,
    runnerService as never,
    { create: jest.fn().mockResolvedValue(runnerAdapter) } as never,
    {
      getSnapshotByName: jest.fn().mockResolvedValue({
        name: 'runtime-snapshot',
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
    store as never,
    dataSource as never,
  )
  return { service, sandbox, manager, store, runnerAdapter, runnerService, redisLockProvider, dataSource }
}

describe('SandboxWorkspaceRecoveryService', () => {
  it('registers the exact replacement Volume, rebinds the stable sandbox, and recreates compute on the requested owner', async () => {
    const harness = createHarness()

    await expect(harness.service.recover(sandboxId, organizationId, recoveryInput())).resolves.toEqual(expectedResult())

    expect(harness.manager.insert).toHaveBeenCalledWith(
      Volume,
      expect.objectContaining({
        id: replacementVolumeId,
        organizationId,
        name: replacementVolumeId,
        state: VolumeState.READY,
      }),
    )
    expect(harness.manager.update).toHaveBeenCalledWith(
      Sandbox,
      expect.objectContaining({ id: sandboxId, organizationId }),
      expect.objectContaining({
        runnerId: ownerRunnerId,
        state: SandboxState.UNKNOWN,
        desiredState: SandboxDesiredState.STARTED,
        volumes: [
          {
            volumeId: replacementVolumeId,
            mountPath: '/workspace',
            subpath,
          },
          {
            volumeId: replacementVolumeId,
            mountPath: '/config',
            subpath,
          },
        ],
      }),
    )
    expect(harness.runnerAdapter.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sandboxId,
        runnerId: ownerRunnerId,
        volumes: expect.arrayContaining([
          expect.objectContaining({ volumeId: replacementVolumeId, mountPath: '/workspace', subpath }),
          expect.objectContaining({ volumeId: replacementVolumeId, mountPath: '/config', subpath }),
        ]),
      }),
      'registry.example.com/runtime@sha256:abc',
      undefined,
      ['/usr/bin/start'],
      expect.objectContaining({ sandboxName: `DESTROYED_workspace_1` }),
      'http://otel:4318',
    )
    expect(harness.store.begin).toHaveBeenCalledTimes(1)
    expect(harness.store.advance).toHaveBeenNthCalledWith(
      1,
      sandboxId,
      operationId,
      recoveryInput(),
      'binding_committed',
    )
    expect(harness.store.advance).toHaveBeenNthCalledWith(
      2,
      sandboxId,
      operationId,
      recoveryInput(),
      'compute_requested',
    )
    expect(harness.store.complete).toHaveBeenCalledWith(sandboxId, operationId, recoveryInput(), expectedResult())
  })

  it('replays a completed operation with zero database, lock, or Runner side effects', async () => {
    const store = operationStore()
    store.get.mockResolvedValue({
      status: 'complete',
      phase: 'complete',
      operationId,
      sandboxId,
      request: recoveryInput(),
      result: expectedResult(),
    })
    const harness = createHarness({ store })

    await expect(harness.service.recover(sandboxId, organizationId, recoveryInput())).resolves.toEqual(expectedResult())

    expect(harness.redisLockProvider.lock).not.toHaveBeenCalled()
    expect(harness.dataSource.transaction).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    expect(store.begin).not.toHaveBeenCalled()
    expect(store.advance).not.toHaveBeenCalled()
    expect(store.complete).not.toHaveBeenCalled()
  })

  it('rejects operation replay when the owner, Volume, mount, or subpath differs', async () => {
    const cases: RecoverSandboxWorkspaceInput[] = [
      recoveryInput({ ownerRunnerId: '77777777-7777-4777-8777-777777777777' }),
      recoveryInput({ workspace: { ...recoveryInput().workspace, volumeId: '88888888-8888-4888-8888-888888888888' } }),
      recoveryInput({ workspace: { ...recoveryInput().workspace, mountPath: '/different' as '/workspace' } }),
      recoveryInput({ workspace: { ...recoveryInput().workspace, subpath: 'sandboxes/other/workspace' } }),
    ]

    for (const input of cases) {
      const store = operationStore()
      store.get.mockResolvedValue({
        status: 'running',
        phase: 'prepared',
        operationId,
        sandboxId,
        request: recoveryInput(),
      })
      const harness = createHarness({ store })

      await expect(harness.service.recover(sandboxId, organizationId, input)).rejects.toBeInstanceOf(
        BadRequestException,
      )
      expect(harness.redisLockProvider.lock).not.toHaveBeenCalled()
      expect(harness.dataSource.transaction).not.toHaveBeenCalled()
      expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    }
  })

  it('resumes after a committed rebind without registering or rebinding the replacement twice', async () => {
    const rebound = destroyedSandbox()
    Object.assign(rebound, {
      runnerId: ownerRunnerId,
      state: SandboxState.UNKNOWN,
      desiredState: SandboxDesiredState.STARTED,
      pending: true,
      volumes: [
        {
          volumeId: replacementVolumeId,
          mountPath: '/workspace',
          subpath,
        },
        {
          volumeId: replacementVolumeId,
          mountPath: '/config',
          subpath,
        },
      ],
    })
    const volume = {
      id: replacementVolumeId,
      organizationId,
      name: replacementVolumeId,
      state: VolumeState.READY,
    } as Volume
    const store = operationStore()
    store.get.mockResolvedValue({
      status: 'running',
      phase: 'prepared',
      operationId,
      sandboxId,
      request: recoveryInput(),
    })
    const harness = createHarness({ sandbox: rebound, volume, store })

    await expect(harness.service.recover(sandboxId, organizationId, recoveryInput())).resolves.toEqual(expectedResult())

    expect(harness.manager.insert).not.toHaveBeenCalled()
    expect(harness.manager.update).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).toHaveBeenCalledTimes(1)
    expect(store.advance).toHaveBeenCalledWith(sandboxId, operationId, recoveryInput(), 'binding_committed')
  })

  it('completes a rebound operation with already started compute without creating it again', async () => {
    const rebound = destroyedSandbox()
    Object.assign(rebound, {
      runnerId: ownerRunnerId,
      state: SandboxState.STARTED,
      desiredState: SandboxDesiredState.STARTED,
      pending: false,
      volumes: [
        {
          volumeId: replacementVolumeId,
          mountPath: '/workspace',
          subpath,
        },
        {
          volumeId: replacementVolumeId,
          mountPath: '/config',
          subpath,
        },
      ],
    })
    const volume = {
      id: replacementVolumeId,
      organizationId,
      name: replacementVolumeId,
      state: VolumeState.READY,
    } as Volume
    const store = operationStore()
    store.get.mockResolvedValue({
      status: 'running',
      phase: 'compute_requested',
      operationId,
      sandboxId,
      request: recoveryInput(),
    })
    const sandboxInfo = jest.fn().mockResolvedValue({ state: SandboxState.STARTED })
    const harness = createHarness({ sandbox: rebound, volume, store, sandboxInfo })

    await expect(harness.service.recover(sandboxId, organizationId, recoveryInput())).resolves.toEqual(expectedResult())

    expect(harness.manager.insert).not.toHaveBeenCalled()
    expect(harness.manager.update).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
    expect(sandboxInfo).toHaveBeenCalledTimes(1)
    expect(store.complete).toHaveBeenCalledWith(sandboxId, operationId, recoveryInput(), expectedResult())
  })

  it.each([
    { name: 'a different Volume name', volume: { name: previousVolumeId } },
    { name: 'a different organization', volume: { organizationId: '77777777-7777-4777-8777-777777777777' } },
    { name: 'a non-ready Volume state', volume: { state: VolumeState.ERROR } },
  ])('rejects a replacement Volume with $name without rebinding or creating compute', async ({ volume }) => {
    const harness = createHarness({
      volume: {
        id: replacementVolumeId,
        organizationId,
        name: replacementVolumeId,
        state: VolumeState.READY,
        ...volume,
      } as Volume,
    })

    await expect(harness.service.recover(sandboxId, organizationId, recoveryInput())).rejects.toThrow()

    expect(harness.manager.insert).not.toHaveBeenCalled()
    expect(harness.manager.update).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('rejects a non-canonical recovery request before taking the state-change lock', async () => {
    const harness = createHarness()

    await expect(
      harness.service.recover(
        sandboxId,
        organizationId,
        recoveryInput({ workspace: { ...recoveryInput().workspace, subpath: `sandboxes/${sandboxId}/other` } }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException)

    expect(harness.redisLockProvider.lock).not.toHaveBeenCalled()
    expect(harness.dataSource.transaction).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('does not persist an operation when the requested owner is unavailable', async () => {
    const harness = createHarness()
    harness.runnerService.findOne.mockResolvedValue({
      ...ownerRunner(),
      state: RunnerState.UNRESPONSIVE,
    })

    await expect(harness.service.recover(sandboxId, organizationId, recoveryInput())).rejects.toThrow()

    expect(harness.store.begin).not.toHaveBeenCalled()
    expect(harness.manager.insert).not.toHaveBeenCalled()
    expect(harness.manager.update).not.toHaveBeenCalled()
    expect(harness.runnerAdapter.createSandbox).not.toHaveBeenCalled()
  })
})
