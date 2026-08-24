/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { BackupState } from '../../enums/backup-state.enum'
import { RunnerState } from '../../enums/runner-state.enum'
import { SandboxDesiredState } from '../../enums/sandbox-desired-state.enum'
import { SandboxState } from '../../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../../enums/sandbox-storage-backend.enum'
import { SnapshotRunnerState } from '../../enums/snapshot-runner-state.enum'
import { Runner } from '../../entities/runner.entity'
import { Sandbox } from '../../entities/sandbox.entity'
import { Snapshot } from '../../entities/snapshot.entity'
import { DONT_SYNC_AGAIN, SYNC_AGAIN } from './sandbox.action'
import { SandboxStartAction } from './sandbox-start.action'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const otherRunnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const lockCode = { getCode: () => 'local-owner-test-lock' }

function ownerRunner(overrides: Partial<Runner> = {}): Runner {
  return {
    id: ownerId,
    region: 'local',
    state: RunnerState.READY,
    unschedulable: false,
    draining: false,
    localVolumeEnabled: true,
    serviceHealth: [{ serviceName: 'local-volume', healthy: true }],
    availabilityScore: 100,
    ...overrides,
  } as Runner
}

function localSandbox(state: SandboxState): Sandbox {
  return {
    id: sandboxId,
    name: 'local-owner-test',
    organizationId: '55555555-5555-4555-8555-555555555555',
    region: 'local',
    runnerId: ownerId,
    storageBackend: SandboxStorageBackend.LOCAL,
    state,
    desiredState: SandboxDesiredState.STARTED,
    pending: true,
    snapshot: 'base-snapshot',
    backupState: BackupState.NONE,
    volumes: [
      {
        volumeId,
        mountPath: '/workspace',
        subpath: `sandboxes/${sandboxId}/workspace`,
      },
    ],
  } as Sandbox
}

function createAction(params?: {
  runner?: Runner | null
  snapshotRunnerState?: SnapshotRunnerState | null
  snapshotExists?: boolean
  startError?: Error
}) {
  const runner = params?.runner === undefined ? ownerRunner() : params.runner
  const ownerAdapter = {
    startSandbox: params?.startError
      ? jest.fn().mockRejectedValue(params.startError)
      : jest.fn().mockResolvedValue(undefined),
    createSandbox: jest.fn().mockResolvedValue({ daemonVersion: 'test' }),
    snapshotExists: jest.fn().mockResolvedValue(params?.snapshotExists ?? false),
  }
  const otherRunnerAdapter = {
    startSandbox: jest.fn(),
    createSandbox: jest.fn(),
  }
  const runnerService = {
    findOne: jest.fn().mockResolvedValue(runner),
    findOneOrFail: jest.fn().mockResolvedValue(runner),
    getSnapshotRunner: jest.fn().mockResolvedValue(
      params?.snapshotRunnerState
        ? {
            runnerId: ownerId,
            snapshotRef: 'snapshot-ref',
            state: params.snapshotRunnerState,
          }
        : null,
    ),
    createSnapshotRunnerEntry: jest.fn().mockResolvedValue(undefined),
    getRandomAvailableRunner: jest.fn().mockResolvedValue({ id: otherRunnerId }),
  }
  const runnerAdapterFactory = {
    create: jest.fn(async (selectedRunner: Runner) =>
      selectedRunner.id === ownerId ? ownerAdapter : otherRunnerAdapter,
    ),
  }
  const snapshot = {
    name: 'base-snapshot',
    ref: 'snapshot-ref',
    entrypoint: [],
  } as Snapshot
  const snapshotService = {
    getSnapshotByName: jest.fn().mockResolvedValue(snapshot),
    getEntrypointFromDockerfile: jest.fn().mockReturnValue([]),
  }
  const organizationService = {
    findOne: jest.fn().mockResolvedValue({ sandboxMetadata: {} }),
  }
  const action = new SandboxStartAction(
    runnerService as never,
    runnerAdapterFactory as never,
    {} as never,
    snapshotService as never,
    {
      getSourceRegistriesForDockerfile: jest.fn(),
      findOne: jest.fn(),
      findInternalRegistryBySnapshotRef: jest.fn().mockResolvedValue(undefined),
    } as never,
    organizationService as never,
    { get: jest.fn(), getOrThrow: jest.fn() } as never,
    {} as never,
    {} as never,
    { getLastActivityAt: jest.fn() } as never,
  )
  const updateSandboxState = jest
    .spyOn(action as unknown as { updateSandboxState: (...args: unknown[]) => Promise<void> }, 'updateSandboxState')
    .mockResolvedValue(undefined)

  return {
    action,
    ownerAdapter,
    otherRunnerAdapter,
    runnerService,
    runnerAdapterFactory,
    snapshot,
    updateSandboxState,
  }
}

describe('SandboxStartAction local owner pinning', () => {
  it('does not run replacement logic for a legacy COS sandbox', async () => {
    const sandbox = localSandbox(SandboxState.ARCHIVED)
    sandbox.storageBackend = SandboxStorageBackend.COS
    const harness = createAction()

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)

    expect(harness.runnerService.findOne).not.toHaveBeenCalled()
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(harness.runnerAdapterFactory.create).not.toHaveBeenCalled()
    expect(harness.updateSandboxState).not.toHaveBeenCalled()
  })

  it('pulls a missing snapshot only on the persisted owner', async () => {
    const sandbox = localSandbox(SandboxState.PULLING_SNAPSHOT)
    const harness = createAction()
    const pullSnapshot = jest.spyOn(harness.action, 'pullSnapshotToRunner').mockResolvedValue(undefined)

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(SYNC_AGAIN)

    expect(harness.runnerService.createSnapshotRunnerEntry).toHaveBeenCalledWith(
      ownerId,
      'snapshot-ref',
      SnapshotRunnerState.PULLING_SNAPSHOT,
    )
    expect(pullSnapshot).toHaveBeenCalledWith(harness.snapshot, expect.objectContaining({ id: ownerId }))
    expect(harness.updateSandboxState).toHaveBeenCalledWith(sandbox, SandboxState.PULLING_SNAPSHOT, lockCode, ownerId)
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(harness.otherRunnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('creates only after the owner snapshot is ready', async () => {
    const sandbox = localSandbox(SandboxState.PULLING_SNAPSHOT)
    const harness = createAction({ snapshotRunnerState: SnapshotRunnerState.READY })

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(SYNC_AGAIN)

    expect(harness.updateSandboxState).toHaveBeenCalledWith(sandbox, SandboxState.UNKNOWN, lockCode, ownerId)
    expect(harness.runnerService.createSnapshotRunnerEntry).not.toHaveBeenCalled()
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
  })

  it('reconciles a completed owner pull after an API restart', async () => {
    const sandbox = localSandbox(SandboxState.PULLING_SNAPSHOT)
    const harness = createAction({
      snapshotRunnerState: SnapshotRunnerState.PULLING_SNAPSHOT,
      snapshotExists: true,
    })

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(SYNC_AGAIN)

    expect(harness.ownerAdapter.snapshotExists).toHaveBeenCalledWith('snapshot-ref')
    expect(harness.runnerService.createSnapshotRunnerEntry).toHaveBeenCalledWith(
      ownerId,
      'snapshot-ref',
      SnapshotRunnerState.READY,
    )
    expect(harness.updateSandboxState).toHaveBeenCalledWith(sandbox, SandboxState.UNKNOWN, lockCode, ownerId)
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(harness.otherRunnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('does not select another runner while the owner is unavailable', async () => {
    const sandbox = localSandbox(SandboxState.PULLING_SNAPSHOT)
    const harness = createAction({ runner: ownerRunner({ state: RunnerState.UNRESPONSIVE }) })

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)

    expect(sandbox.runnerId).toBe(ownerId)
    expect(harness.updateSandboxState).not.toHaveBeenCalled()
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(harness.runnerAdapterFactory.create).not.toHaveBeenCalled()
  })

  it('does not invoke cross-runner recovery after an owner start error', async () => {
    const sandbox = localSandbox(SandboxState.STOPPED)
    sandbox.backupState = BackupState.COMPLETED
    const harness = createAction({ startError: new Error('Can not connect to the Docker daemon') })

    await expect(harness.action.run(sandbox, lockCode as never)).rejects.toThrow('Can not connect to the Docker daemon')

    expect(sandbox.runnerId).toBe(ownerId)
    expect(harness.ownerAdapter.startSandbox).toHaveBeenCalledTimes(1)
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(harness.otherRunnerAdapter.createSandbox).not.toHaveBeenCalled()
  })

  it('returns to the same owner after it recovers', async () => {
    const sandbox = localSandbox(SandboxState.STOPPED)
    const harness = createAction()
    harness.runnerService.findOne
      .mockResolvedValueOnce(ownerRunner({ state: RunnerState.UNRESPONSIVE }))
      .mockResolvedValueOnce(ownerRunner())

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(DONT_SYNC_AGAIN)
    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(SYNC_AGAIN)

    expect(sandbox.runnerId).toBe(ownerId)
    expect(harness.ownerAdapter.startSandbox).toHaveBeenCalledTimes(1)
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
  })

  it('recreates an archived sandbox only on its owner', async () => {
    const sandbox = localSandbox(SandboxState.ARCHIVED)
    const harness = createAction()

    await expect(harness.action.run(sandbox, lockCode as never)).resolves.toBe(SYNC_AGAIN)

    expect(harness.ownerAdapter.createSandbox).toHaveBeenCalledWith(
      sandbox,
      'snapshot-ref',
      undefined,
      [],
      expect.objectContaining({ sandboxName: sandbox.name }),
      undefined,
    )
    expect(harness.runnerService.getRandomAvailableRunner).not.toHaveBeenCalled()
    expect(harness.otherRunnerAdapter.createSandbox).not.toHaveBeenCalled()
  })
})
