/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import 'reflect-metadata'
import { Organization } from '../../organization/entities/organization.entity'
import { Region } from '../../region/entities/region.entity'
import { BadRequestError } from '../../exceptions/bad-request.exception'
import { CreateSandboxDto } from '../dto/create-sandbox.dto'
import { SandboxDto } from '../dto/sandbox.dto'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { Snapshot } from '../entities/snapshot.entity'
import { RunnerState } from '../enums/runner-state.enum'
import { BackupState } from '../enums/backup-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { SnapshotState } from '../enums/snapshot-state.enum'
import { OwnerRunnerUnavailableError } from '../errors/owner-runner-unavailable.error'
import { SandboxService } from './sandbox.service'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const ownerId = '22222222-2222-4222-8222-222222222222'
const organizationId = '33333333-3333-4333-8333-333333333333'
const snapshotId = '44444444-4444-4444-8444-444444444444'
const volumeId = '55555555-5555-4555-8555-555555555555'

function createHarness() {
  const owner = {
    id: ownerId,
    region: 'local',
    state: RunnerState.READY,
    unschedulable: false,
    draining: false,
    localVolumeEnabled: true,
  } as Runner
  const snapshot = {
    id: snapshotId,
    name: 'base-snapshot',
    ref: 'registry/base-snapshot:latest',
    state: SnapshotState.ACTIVE,
    sandboxClass: SandboxClass.CONTAINER,
    cpu: 1,
    mem: 1,
    disk: 3,
    gpu: 0,
    entrypoint: [],
  } as Snapshot
  const region = {
    id: 'local',
    enforceQuotas: false,
  } as Region
  const organization = {
    id: organizationId,
    defaultRegionId: region.id,
    maxCpuPerSandbox: 100,
    maxMemoryPerSandbox: 100,
    maxDiskPerSandbox: 100,
  } as Organization
  const sandboxRepository = {
    insert: jest.fn(async (sandbox: Sandbox) => sandbox),
    update: jest.fn(),
  }
  const snapshotRepository = {
    find: jest.fn().mockResolvedValue([snapshot]),
  }
  const runnerService = {
    getRandomAvailableRunner: jest
      .fn()
      .mockRejectedValueOnce(new BadRequestError('No available runners with requested snapshot'))
      .mockResolvedValueOnce(owner),
    findOne: jest.fn().mockResolvedValue(owner),
    findOneOrFail: jest.fn().mockResolvedValue(owner),
  }
  const volumeService = {
    getVolumesByIdOrName: jest.fn().mockResolvedValue(new Map([[volumeId, { id: volumeId }]])),
  }
  const configService = {
    get: jest.fn((key: string) => (key === 'localVolume.enabled' ? true : undefined)),
    getOrThrow: jest.fn(),
  }
  const organizationService = {
    assertOrganizationIsNotSuspended: jest.fn(),
  }
  const organizationUsageService = {
    incrementPendingSandboxUsage: jest.fn(),
  }
  const eventEmitter = {
    emit: jest.fn(),
    emitAsync: jest.fn().mockResolvedValue(undefined),
  }
  const regionService = {
    findOne: jest.fn().mockResolvedValue(region),
  }
  const snapshotService = {
    isAvailableInRegion: jest.fn().mockResolvedValue(true),
  }

  const service = new SandboxService(
    sandboxRepository as never,
    snapshotRepository as never,
    {} as never,
    {} as never,
    {} as never,
    runnerService as never,
    volumeService as never,
    configService as never,
    {} as never,
    eventEmitter as never,
    organizationService as never,
    {} as never,
    organizationUsageService as never,
    {} as never,
    {} as never,
    regionService as never,
    snapshotService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  )
  jest.spyOn(service, 'toSandboxDto').mockImplementation(async (sandbox) => sandbox as unknown as SandboxDto)

  return {
    service,
    eventEmitter,
    owner,
    snapshot,
    region,
    organization,
    sandboxRepository,
    runnerService,
    organizationUsageService,
  }
}

describe('SandboxService local owner placement', () => {
  it('persists one owner before pulling a missing snapshot', async () => {
    const harness = createHarness()
    const createDto = {
      id: sandboxId,
      name: 'local-placement-test',
      snapshot: harness.snapshot.name,
      storageBackend: SandboxStorageBackend.LOCAL,
      volumes: [
        {
          volumeId,
          mountPath: '/workspace',
          subpath: `sandboxes/${sandboxId}/workspace`,
        },
      ],
    } as CreateSandboxDto

    const created = await harness.service.createFromSnapshot(createDto, harness.organization)

    expect(created).toMatchObject({
      id: sandboxId,
      runnerId: ownerId,
      storageBackend: SandboxStorageBackend.LOCAL,
      state: SandboxState.PULLING_SNAPSHOT,
      pending: true,
    })
    expect(harness.sandboxRepository.insert).toHaveBeenCalledTimes(1)
    expect(harness.sandboxRepository.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: sandboxId,
        runnerId: ownerId,
        storageBackend: SandboxStorageBackend.LOCAL,
        state: SandboxState.PULLING_SNAPSHOT,
      }),
    )
    expect(harness.runnerService.getRandomAvailableRunner).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ snapshotRef: harness.snapshot.ref, localVolumeEnabled: true }),
    )
    expect(harness.runnerService.getRandomAvailableRunner).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshotRef: undefined, localVolumeEnabled: true }),
    )
  })

  it('returns owner_runner_unavailable before mutating start state', async () => {
    const harness = createHarness()
    const sandbox = {
      id: sandboxId,
      organizationId,
      region: harness.region.id,
      runnerId: ownerId,
      storageBackend: SandboxStorageBackend.LOCAL,
      state: SandboxState.STOPPED,
      desiredState: SandboxDesiredState.STOPPED,
      pending: false,
    } as Sandbox
    jest.spyOn(harness.service, 'findOneByIdOrName').mockResolvedValue(sandbox)
    harness.runnerService.findOne.mockResolvedValue({
      ...harness.owner,
      state: RunnerState.UNRESPONSIVE,
    })

    let caught: unknown
    try {
      await harness.service.start(sandbox.id, harness.organization)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(OwnerRunnerUnavailableError)
    expect((caught as OwnerRunnerUnavailableError).getResponse()).toMatchObject({
      statusCode: 503,
      code: 'owner_runner_unavailable',
      ownerRunnerId: ownerId,
    })
    expect(sandbox.runnerId).toBe(ownerId)
    expect(harness.sandboxRepository.update).not.toHaveBeenCalled()
    expect(harness.organizationUsageService.incrementPendingSandboxUsage).not.toHaveBeenCalled()
  })

  it('rejects resize on an unavailable owner before quota or state mutation', async () => {
    const harness = createHarness()
    const sandbox = {
      id: sandboxId,
      organizationId,
      region: harness.region.id,
      runnerId: ownerId,
      storageBackend: SandboxStorageBackend.LOCAL,
      sandboxClass: SandboxClass.CONTAINER,
      state: SandboxState.STOPPED,
      desiredState: SandboxDesiredState.STOPPED,
      pending: false,
      cpu: 1,
      mem: 1,
      disk: 3,
      gpu: 0,
    } as Sandbox
    jest.spyOn(harness.service, 'findOneByIdOrName').mockResolvedValue(sandbox)
    harness.runnerService.findOneOrFail.mockResolvedValue({
      ...harness.owner,
      state: RunnerState.UNRESPONSIVE,
    })

    await expect(harness.service.resize(sandbox.id, { disk: 4 }, harness.organization)).rejects.toBeInstanceOf(
      OwnerRunnerUnavailableError,
    )

    expect(sandbox.runnerId).toBe(ownerId)
    expect(harness.sandboxRepository.update).not.toHaveBeenCalled()
    expect(harness.organizationUsageService.incrementPendingSandboxUsage).not.toHaveBeenCalled()
  })

  it('rejects manual backup for local storage before emitting a backup event', async () => {
    const harness = createHarness()
    const sandbox = {
      id: sandboxId,
      runnerId: ownerId,
      storageBackend: SandboxStorageBackend.LOCAL,
      state: SandboxState.STOPPED,
      desiredState: SandboxDesiredState.STOPPED,
      backupState: BackupState.NONE,
    } as Sandbox
    jest.spyOn(harness.service, 'findOneByIdOrName').mockResolvedValue(sandbox)

    await expect(harness.service.createBackup(sandbox.id, organizationId)).rejects.toThrow(
      'Local volume sandbox backups are not supported in V1',
    )

    expect(harness.eventEmitter.emit).not.toHaveBeenCalled()
  })
})
