/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { TypedConfigService } from '../../config/typed-config.service'
import { isCanonicalV4Uuid } from '../../common/utils/uuid'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { OrganizationService } from '../../organization/services/organization.service'
import { LockCode, RedisLockProvider } from '../common/redis-lock.provider'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { Volume } from '../entities/volume.entity'
import { SandboxConflictError } from '../errors/sandbox-conflict.error'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { VolumeState } from '../enums/volume-state.enum'
import { assertLocalOwnerAvailable, assertLocalStorageBackend } from '../local-volume/local-volume.contract'
import { SandboxStartAction } from '../managers/sandbox-actions/sandbox-start.action'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { RunnerAdapter, RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { isRegistryBasedSandboxClass } from '../utils/sandbox-class.util'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { RunnerService } from './runner.service'
import { SandboxWorkspaceRecoveryOperationStore } from './sandbox-workspace-recovery-operation.store'
import { SnapshotService } from './snapshot.service'

const RECOVERY_LOCK_TTL_SECONDS = 5 * 60
const RECOVERY_LOCK_HEARTBEAT_MS = 60 * 1000
const RUNNER_STATE_ATTEMPTS = 300

export interface RecoverSandboxWorkspaceInput {
  operationId: string
  ownerRunnerId: string
  workspace: {
    volumeId: string
    mountPath: '/workspace'
    subpath: string
  }
}

export interface RecoveredSandboxWorkspaceResult {
  outcome: 'recovered'
  operationId: string
  sandboxId: string
  externalId: string
  ownerRunnerId: string
  status: 'running'
  workspace: RecoverSandboxWorkspaceInput['workspace']
}

export type SandboxWorkspaceRecoveryResult =
  | RecoveredSandboxWorkspaceResult
  | { outcome: 'operation_in_progress'; operationId: string; sandboxId: string }

interface ResolvedRecoverySnapshot {
  ref: string
  entrypoint?: string[]
  registry?: DockerRegistry
}

@Injectable()
export class SandboxWorkspaceRecoveryService {
  constructor(
    private readonly sandboxRepository: SandboxRepository,
    private readonly runnerService: RunnerService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly snapshotService: SnapshotService,
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly organizationService: OrganizationService,
    private readonly sandboxStartAction: SandboxStartAction,
    private readonly configService: TypedConfigService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly operationStore: SandboxWorkspaceRecoveryOperationStore,
    private readonly dataSource: DataSource,
  ) {}

  async recover(
    sandboxId: string,
    organizationId: string,
    input: RecoverSandboxWorkspaceInput,
  ): Promise<SandboxWorkspaceRecoveryResult> {
    const request = validateRequest(sandboxId, input)
    let operation = await this.operationStore.get(sandboxId, request.operationId)
    if (operation) {
      assertSameRequest(operation.request, request)
      if (operation.status === 'complete') return operation.result
    }

    const lockKey = getStateChangeLockKey(sandboxId)
    const lockCode = new LockCode(request.operationId)
    if (!(await this.redisLockProvider.lock(lockKey, RECOVERY_LOCK_TTL_SECONDS, lockCode))) {
      return { outcome: 'operation_in_progress', operationId: request.operationId, sandboxId }
    }

    let lockLost = false
    const heartbeat = setInterval(() => {
      this.redisLockProvider
        .refreshOwned(lockKey, RECOVERY_LOCK_TTL_SECONDS, lockCode)
        .then((refreshed) => {
          if (!refreshed) lockLost = true
        })
        .catch(() => {
          lockLost = true
        })
    }, RECOVERY_LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    const assertLockOwned = async () => {
      if (lockLost || !(await this.redisLockProvider.refreshOwned(lockKey, RECOVERY_LOCK_TTL_SECONDS, lockCode))) {
        throw new SandboxConflictError()
      }
    }

    try {
      const initialSandbox = await this.sandboxRepository.findOneOrFail({
        where: { id: sandboxId, organizationId },
        relations: ['buildInfo'],
      })
      assertLocalStorageBackend(initialSandbox)
      assertRecoverableSandboxState(initialSandbox, request)

      const owner = await this.runnerService.findOne(request.ownerRunnerId)
      assertRequestedOwnerAvailable(owner, request.ownerRunnerId)
      if (!owner) throw new SandboxConflictError()

      const runnerAdapter = await this.runnerAdapterFactory.create(owner)
      const snapshot = await this.resolveSnapshot(initialSandbox, owner)
      await this.ensureSnapshotAvailable(runnerAdapter, initialSandbox, owner, snapshot)
      await assertLockOwned()

      if (!operation) {
        if (!(await this.operationStore.begin(sandboxId, request.operationId, request))) {
          operation = await this.operationStore.get(sandboxId, request.operationId)
          if (!operation) {
            return { outcome: 'operation_in_progress', operationId: request.operationId, sandboxId }
          }
          assertSameRequest(operation.request, request)
          if (operation.status === 'complete') return operation.result
        }
      }

      const reboundSandbox = await this.registerReplacementAndRebind(sandboxId, organizationId, request)
      await this.operationStore.advance(sandboxId, request.operationId, request, 'binding_committed')
      await assertLockOwned()

      let runnerState = await this.readRunnerState(runnerAdapter, sandboxId)
      if (runnerState === SandboxState.DESTROYED) {
        await this.operationStore.advance(sandboxId, request.operationId, request, 'compute_requested')
        await assertLockOwned()
        const organization = await this.organizationService.findOne(organizationId)
        await runnerAdapter.createSandbox(
          reboundSandbox,
          snapshot.ref,
          snapshot.registry,
          snapshot.entrypoint,
          { ...organization?.sandboxMetadata, sandboxName: reboundSandbox.name },
          this.configService.get('otelCollector.endpointUrl'),
        )
        runnerState = await this.waitForRunnerStarted(runnerAdapter, sandboxId)
      } else if (runnerState === SandboxState.CREATING || runnerState === SandboxState.STARTING) {
        await this.operationStore.advance(sandboxId, request.operationId, request, 'compute_requested')
        runnerState = await this.waitForRunnerStarted(runnerAdapter, sandboxId)
      }
      if (runnerState !== SandboxState.STARTED) throw workspaceRecoveryConflict()

      await assertLockOwned()
      const result: RecoveredSandboxWorkspaceResult = {
        outcome: 'recovered',
        operationId: request.operationId,
        sandboxId,
        externalId: sandboxId,
        ownerRunnerId: request.ownerRunnerId,
        status: 'running',
        workspace: request.workspace,
      }
      await this.operationStore.complete(sandboxId, request.operationId, request, result)
      return result
    } finally {
      clearInterval(heartbeat)
      await this.redisLockProvider.unlockOwned(lockKey, lockCode)
    }
  }

  private async registerReplacementAndRebind(
    sandboxId: string,
    organizationId: string,
    request: RecoverSandboxWorkspaceInput,
  ): Promise<Sandbox> {
    return this.dataSource.transaction(async (manager) => {
      const sandbox = await manager.findOne(Sandbox, {
        where: { id: sandboxId, organizationId },
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })
      if (!sandbox) throw workspaceRecoveryConflict()
      assertLocalStorageBackend(sandbox)
      assertRecoverableSandboxState(sandbox, request)

      const volume = await manager.findOne(Volume, {
        where: [{ id: request.workspace.volumeId }, { organizationId, name: request.workspace.volumeId }],
        lock: { mode: 'pessimistic_write' },
      })
      if (volume && !isExactRegisteredVolume(volume, organizationId, request.workspace.volumeId)) {
        throw workspaceRecoveryConflict()
      }

      if (isExactReboundSandbox(sandbox, request)) {
        if (!volume) throw workspaceRecoveryConflict()
        return sandbox
      }
      if (
        sandbox.state !== SandboxState.DESTROYED ||
        sandbox.desiredState !== SandboxDesiredState.DESTROYED ||
        sandbox.pending ||
        (sandbox.runnerId != null && sandbox.runnerId !== request.ownerRunnerId)
      ) {
        throw workspaceRecoveryConflict()
      }

      if (!volume) {
        await manager.insert(Volume, {
          id: request.workspace.volumeId,
          organizationId,
          name: request.workspace.volumeId,
          state: VolumeState.READY,
        })
      }
      const volumes = canonicalRecoveryMounts(request)
      const update: Partial<Sandbox> = {
        runnerId: request.ownerRunnerId,
        prevRunnerId: request.ownerRunnerId,
        state: SandboxState.UNKNOWN,
        desiredState: SandboxDesiredState.STARTED,
        pending: true,
        volumes,
        errorReason: null,
        recoverable: false,
      }
      const updated = await manager.update(
        Sandbox,
        {
          id: sandboxId,
          organizationId,
          state: SandboxState.DESTROYED,
          desiredState: SandboxDesiredState.DESTROYED,
          pending: false,
        },
        update,
      )
      if (updated.affected !== 1) throw workspaceRecoveryConflict()
      Object.assign(sandbox, update)
      return sandbox
    })
  }

  private async resolveSnapshot(sandbox: Sandbox, owner: Runner): Promise<ResolvedRecoverySnapshot> {
    if (sandbox.buildInfo) {
      return {
        ref: sandbox.buildInfo.snapshotRef,
        entrypoint: this.snapshotService.getEntrypointFromDockerfile(sandbox.buildInfo.dockerfileContent),
      }
    }
    if (!sandbox.snapshot?.trim()) throw workspaceRecoveryConflict()
    const snapshot = await this.snapshotService.getSnapshotByName(sandbox.snapshot, sandbox.organizationId)
    const registry = isRegistryBasedSandboxClass(snapshot.sandboxClass)
      ? ((await this.dockerRegistryService.findInternalRegistryBySnapshotRef(snapshot.ref, owner.region)) ?? undefined)
      : undefined
    return { ref: snapshot.ref, entrypoint: snapshot.entrypoint, registry }
  }

  private async ensureSnapshotAvailable(
    runnerAdapter: RunnerAdapter,
    sandbox: Sandbox,
    owner: Runner,
    snapshot: ResolvedRecoverySnapshot,
  ): Promise<void> {
    if (await runnerAdapter.snapshotExists(snapshot.ref)) return
    if (sandbox.buildInfo) throw workspaceRecoveryConflict()
    const persisted = await this.snapshotService.getSnapshotByName(sandbox.snapshot, sandbox.organizationId)
    await this.sandboxStartAction.pullSnapshotToRunner(persisted, owner)
  }

  private async readRunnerState(runnerAdapter: RunnerAdapter, sandboxId: string): Promise<SandboxState> {
    try {
      return (await runnerAdapter.sandboxInfo(sandboxId)).state
    } catch (error) {
      if (isNotFound(error)) return SandboxState.DESTROYED
      throw error
    }
  }

  private async waitForRunnerStarted(runnerAdapter: RunnerAdapter, sandboxId: string): Promise<SandboxState> {
    for (let attempt = 0; attempt < RUNNER_STATE_ATTEMPTS; attempt++) {
      const state = await this.readRunnerState(runnerAdapter, sandboxId)
      if (state === SandboxState.STARTED) return state
      if (state === SandboxState.ERROR || state === SandboxState.BUILD_FAILED) {
        throw workspaceRecoveryConflict()
      }
      if (attempt + 1 < RUNNER_STATE_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    throw workspaceRecoveryConflict()
  }
}

function validateRequest(sandboxId: string, input: RecoverSandboxWorkspaceInput): RecoverSandboxWorkspaceInput {
  const operationId = input.operationId?.toLowerCase()
  const ownerRunnerId = input.ownerRunnerId?.toLowerCase()
  const volumeId = input.workspace?.volumeId?.toLowerCase()
  const expectedSubpath = `sandboxes/${sandboxId}/workspace`
  if (
    !isCanonicalV4Uuid(sandboxId) ||
    !isCanonicalV4Uuid(operationId) ||
    !isCanonicalV4Uuid(ownerRunnerId) ||
    !isCanonicalV4Uuid(volumeId) ||
    input.workspace?.mountPath !== '/workspace' ||
    input.workspace?.subpath !== expectedSubpath
  ) {
    throw new BadRequestException('Invalid sandbox workspace recovery request')
  }
  return {
    operationId,
    ownerRunnerId,
    workspace: { volumeId, mountPath: '/workspace', subpath: expectedSubpath },
  }
}

function assertSameRequest(expected: RecoverSandboxWorkspaceInput, actual: RecoverSandboxWorkspaceInput): void {
  if (
    expected.operationId !== actual.operationId ||
    expected.ownerRunnerId !== actual.ownerRunnerId ||
    expected.workspace.volumeId !== actual.workspace.volumeId ||
    expected.workspace.mountPath !== actual.workspace.mountPath ||
    expected.workspace.subpath !== actual.workspace.subpath
  ) {
    throw new BadRequestException('Recovery operation request does not match its original request')
  }
}

function assertRecoverableSandboxState(sandbox: Sandbox, request: RecoverSandboxWorkspaceInput): void {
  if (sandbox.id === request.workspace.volumeId || sandbox.storageBackend !== SandboxStorageBackend.LOCAL) {
    throw workspaceRecoveryConflict()
  }
  if (sandbox.runnerId != null && sandbox.runnerId !== request.ownerRunnerId) {
    throw workspaceRecoveryConflict()
  }
  if (sandbox.state === SandboxState.DESTROYED && sandbox.desiredState === SandboxDesiredState.DESTROYED) return
  if (isExactReboundSandbox(sandbox, request)) return
  throw workspaceRecoveryConflict()
}

function assertRequestedOwnerAvailable(owner: Runner | null, ownerRunnerId: string): void {
  assertLocalOwnerAvailable({ runnerId: ownerRunnerId }, owner)
}

function canonicalRecoveryMounts(request: RecoverSandboxWorkspaceInput) {
  const identity = {
    volumeId: request.workspace.volumeId,
    subpath: request.workspace.subpath,
  }
  return [
    { ...identity, mountPath: '/workspace' },
    { ...identity, mountPath: '/config' },
  ]
}

function isExactReboundSandbox(sandbox: Sandbox, request: RecoverSandboxWorkspaceInput): boolean {
  if (
    sandbox.runnerId !== request.ownerRunnerId ||
    sandbox.desiredState !== SandboxDesiredState.STARTED ||
    ![
      SandboxState.UNKNOWN,
      SandboxState.CREATING,
      SandboxState.STARTING,
      SandboxState.STARTED,
      SandboxState.STOPPED,
    ].includes(sandbox.state)
  ) {
    return false
  }
  const expected = canonicalRecoveryMounts(request)
  return (
    sandbox.volumes.length === expected.length &&
    expected.every((mount) =>
      sandbox.volumes.some(
        (candidate) =>
          candidate.volumeId === mount.volumeId &&
          candidate.mountPath === mount.mountPath &&
          candidate.subpath === mount.subpath,
      ),
    )
  )
}

function isExactRegisteredVolume(volume: Volume, organizationId: string, volumeId: string): boolean {
  return (
    volume.id === volumeId &&
    volume.organizationId === organizationId &&
    volume.name === volumeId &&
    volume.state === VolumeState.READY
  )
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const value = error as {
    statusCode?: unknown
    response?: { status?: unknown; data?: { statusCode?: unknown } }
  }
  return value.statusCode === 404 || value.response?.status === 404 || value.response?.data?.statusCode === 404
}

function workspaceRecoveryConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'Sandbox workspace recovery identity or state conflicts with the requested operation',
    code: 'workspace_recovery_conflict',
  })
}
