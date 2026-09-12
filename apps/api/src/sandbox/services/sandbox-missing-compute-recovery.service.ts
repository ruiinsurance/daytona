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
import { RunnerApiError } from '../errors/runner-api-error'
import { SandboxConflictError } from '../errors/sandbox-conflict.error'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import { VolumeState } from '../enums/volume-state.enum'
import {
  assertLocalOwnerAvailable,
  assertLocalStorageBackend,
  buildRunnerVolumes,
} from '../local-volume/local-volume.contract'
import { SandboxStartAction } from '../managers/sandbox-actions/sandbox-start.action'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { RunnerAdapter, RunnerAdapterFactory, RunnerSandboxInfo } from '../runner-adapter/runnerAdapter'
import { isRegistryBasedSandboxClass } from '../utils/sandbox-class.util'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { RunnerService } from './runner.service'
import { SandboxMissingComputeRecoveryOperationStore } from './sandbox-missing-compute-recovery-operation.store'
import { SnapshotService } from './snapshot.service'

const RECOVERY_LOCK_TTL_SECONDS = 5 * 60
const RECOVERY_LOCK_HEARTBEAT_MS = 60 * 1000
const RUNNER_STATE_ATTEMPTS = 300

export interface RecoverMissingComputeInput {
  operationId: string
  ownerRunnerId: string
  workspace: {
    volumeId: string
    mountPath: '/workspace'
    subpath: string
  }
}

export interface RecoveredMissingComputeResult {
  outcome: 'recovered'
  operationId: string
  sandboxId: string
  externalId: string
  ownerRunnerId: string
  status: 'running'
  computeCreated: boolean
  workspace: RecoverMissingComputeInput['workspace']
}

export type MissingComputeRecoveryResult =
  | RecoveredMissingComputeResult
  | { outcome: 'operation_in_progress'; operationId: string; sandboxId: string }

interface ResolvedSnapshot {
  ref: string
  entrypoint?: string[]
  registry?: DockerRegistry
}

@Injectable()
export class SandboxMissingComputeRecoveryService {
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
    private readonly operationStore: SandboxMissingComputeRecoveryOperationStore,
    private readonly dataSource: DataSource,
  ) {}

  async recover(
    sandboxId: string,
    organizationId: string,
    input: RecoverMissingComputeInput,
  ): Promise<MissingComputeRecoveryResult> {
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

    let operationOwned = Boolean(operation)
    let asyncStateSnapshot: Pick<Sandbox, 'state' | 'desiredState' | 'pending' | 'errorReason' | 'recoverable'> | null =
      null
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
      const persisted = await this.sandboxRepository.findOneOrFail({
        where: { id: sandboxId, organizationId },
        relations: ['buildInfo'],
      })
      assertExactPersistedIdentity(persisted, request)

      const volume = await this.dataSource.manager.findOne(Volume, {
        where: [{ id: request.workspace.volumeId }, { organizationId, name: request.workspace.volumeId }],
      })
      if (!volume || !isExactRegisteredVolume(volume, organizationId, request.workspace.volumeId)) {
        throw identityConflict()
      }

      const owner = await this.runnerService.findOne(request.ownerRunnerId)
      assertRequestedOwnerAvailable(owner, request.ownerRunnerId)
      if (!owner) throw identityConflict()
      const runnerAdapter = await this.runnerAdapterFactory.create(owner)

      if (!operationOwned) {
        if (!(await this.operationStore.begin(sandboxId, request.operationId, request))) {
          operation = await this.operationStore.get(sandboxId, request.operationId)
          if (!operation) {
            return { outcome: 'operation_in_progress', operationId: request.operationId, sandboxId }
          }
          assertSameRequest(operation.request, request)
          if (operation.status === 'complete') return operation.result
        }
        operationOwned = true
      }

      await assertLockOwned()
      let runnerInfo = await this.readRunnerInfo(runnerAdapter, sandboxId)
      let runnerState = runnerInfo?.state ?? null
      let computeCreated = false
      if (runnerState === null || owner.apiVersion === '2') {
        const snapshot = await this.resolveSnapshot(persisted, owner)
        await this.ensureSnapshotAvailable(runnerAdapter, persisted, owner, snapshot)
        await assertLockOwned()
        await this.operationStore.advance(sandboxId, request.operationId, request, 'compute_requested')
        if (owner.apiVersion === '2') {
          asyncStateSnapshot = {
            state: persisted.state,
            desiredState: persisted.desiredState,
            pending: persisted.pending,
            errorReason: persisted.errorReason,
            recoverable: persisted.recoverable,
          }
          await this.prepareAsyncRecovery(sandboxId, organizationId, request)
        }
        const organization = await this.organizationService.findOne(organizationId)
        try {
          await runnerAdapter.createSandbox(
            persisted,
            snapshot.ref,
            snapshot.registry,
            snapshot.entrypoint,
            { ...organization?.sandboxMetadata, sandboxName: persisted.name },
            this.configService.get('otelCollector.endpointUrl'),
            undefined,
            { requireExistingLocalWorkspace: true },
          )
        } catch (error) {
          if (error instanceof RunnerApiError && error.code === 'LOCAL_WORKSPACE_MISSING') {
            throw workspaceMissing()
          }
          throw error
        }
        computeCreated = runnerState === null
        runnerInfo = await this.waitForRunnerStarted(runnerAdapter, sandboxId)
        runnerState = runnerInfo.state
      } else if (runnerState === SandboxState.STOPPED) {
        await this.operationStore.advance(sandboxId, request.operationId, request, 'compute_requested')
        try {
          await runnerAdapter.startSandbox(sandboxId, persisted.authToken, {
            volumes: JSON.stringify(buildRunnerVolumes(persisted)),
          })
        } catch (error) {
          if (error instanceof RunnerApiError && error.code === 'LOCAL_WORKSPACE_MISSING') {
            throw workspaceMissing()
          }
          throw error
        }
        runnerInfo = await this.waitForRunnerStarted(runnerAdapter, sandboxId)
        runnerState = runnerInfo.state
      } else if (runnerState === SandboxState.CREATING || runnerState === SandboxState.STARTING) {
        runnerInfo = await this.waitForRunnerStarted(runnerAdapter, sandboxId)
        runnerState = runnerInfo.state
      }
      if (runnerState !== SandboxState.STARTED) throw identityConflict()

      await assertLockOwned()
      await this.markStarted(sandboxId, organizationId, request)
      const result: RecoveredMissingComputeResult = {
        outcome: 'recovered',
        operationId: request.operationId,
        sandboxId,
        externalId: sandboxId,
        ownerRunnerId: request.ownerRunnerId,
        status: 'running',
        computeCreated,
        workspace: request.workspace,
      }
      await this.operationStore.complete(sandboxId, request.operationId, request, result)
      operationOwned = false
      return result
    } catch (error) {
      if (asyncStateSnapshot && isWorkspaceMissingError(error)) {
        await this.restoreAsyncRecoveryState(sandboxId, organizationId, request, asyncStateSnapshot).catch(
          () => undefined,
        )
      }
      if (operationOwned) await this.operationStore.abort(sandboxId, request.operationId).catch(() => undefined)
      throw error
    } finally {
      clearInterval(heartbeat)
      await this.redisLockProvider.unlockOwned(lockKey, lockCode)
    }
  }

  private async markStarted(
    sandboxId: string,
    organizationId: string,
    request: RecoverMissingComputeInput,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const sandbox = await manager.findOne(Sandbox, {
        where: { id: sandboxId, organizationId },
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })
      if (!sandbox) throw identityConflict()
      assertExactPersistedIdentity(sandbox, request, true)
      if (
        sandbox.state === SandboxState.STARTED &&
        sandbox.desiredState === SandboxDesiredState.STARTED &&
        !sandbox.pending
      ) {
        return
      }
      const updated = await manager.update(
        Sandbox,
        { id: sandboxId, organizationId },
        {
          state: SandboxState.STARTED,
          desiredState: SandboxDesiredState.STARTED,
          pending: false,
          errorReason: null,
          recoverable: false,
        },
      )
      if (updated.affected !== 1) throw identityConflict()
    })
  }

  private async prepareAsyncRecovery(
    sandboxId: string,
    organizationId: string,
    request: RecoverMissingComputeInput,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const sandbox = await manager.findOne(Sandbox, {
        where: { id: sandboxId, organizationId },
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })
      if (!sandbox) throw identityConflict()
      assertExactPersistedIdentity(sandbox, request)
      const updated = await manager.update(
        Sandbox,
        { id: sandboxId, organizationId },
        {
          state: SandboxState.UNKNOWN,
          desiredState: SandboxDesiredState.STARTED,
          pending: true,
          errorReason: null,
          recoverable: false,
        },
      )
      if (updated.affected !== 1) throw identityConflict()
    })
  }

  private async restoreAsyncRecoveryState(
    sandboxId: string,
    organizationId: string,
    request: RecoverMissingComputeInput,
    snapshot: Pick<Sandbox, 'state' | 'desiredState' | 'pending' | 'errorReason' | 'recoverable'>,
  ): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const sandbox = await manager.findOne(Sandbox, {
        where: { id: sandboxId, organizationId },
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })
      if (!sandbox || !hasExactPersistedIdentity(sandbox, request)) throw identityConflict()
      const updated = await manager.update(Sandbox, { id: sandboxId, organizationId }, snapshot)
      if (updated.affected !== 1) throw identityConflict()
    })
  }

  private async resolveSnapshot(sandbox: Sandbox, owner: Runner): Promise<ResolvedSnapshot> {
    if (sandbox.buildInfo) {
      return {
        ref: sandbox.buildInfo.snapshotRef,
        entrypoint: this.snapshotService.getEntrypointFromDockerfile(sandbox.buildInfo.dockerfileContent),
      }
    }
    if (!sandbox.snapshot?.trim()) throw identityConflict()
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
    snapshot: ResolvedSnapshot,
  ): Promise<void> {
    if (await runnerAdapter.snapshotExists(snapshot.ref)) return
    if (sandbox.buildInfo) throw identityConflict()
    const persisted = await this.snapshotService.getSnapshotByName(sandbox.snapshot, sandbox.organizationId)
    await this.sandboxStartAction.pullSnapshotToRunner(persisted, owner)
  }

  private async readRunnerInfo(runnerAdapter: RunnerAdapter, sandboxId: string): Promise<RunnerSandboxInfo | null> {
    try {
      return await runnerAdapter.sandboxInfo(sandboxId)
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  private async waitForRunnerStarted(runnerAdapter: RunnerAdapter, sandboxId: string): Promise<RunnerSandboxInfo> {
    for (let attempt = 0; attempt < RUNNER_STATE_ATTEMPTS; attempt++) {
      const info = await this.readRunnerInfo(runnerAdapter, sandboxId)
      const state = info?.state ?? null
      if (state === SandboxState.STARTED && info) return info
      if (info?.errorCode === 'LOCAL_WORKSPACE_MISSING') throw workspaceMissing()
      if (state === null || state === SandboxState.ERROR || state === SandboxState.BUILD_FAILED) {
        throw identityConflict()
      }
      if (attempt + 1 < RUNNER_STATE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw identityConflict()
  }
}

function validateRequest(sandboxId: string, input: RecoverMissingComputeInput): RecoverMissingComputeInput {
  const operationId = input.operationId?.toLowerCase()
  const ownerRunnerId = input.ownerRunnerId?.toLowerCase()
  const volumeId = input.workspace?.volumeId?.toLowerCase()
  const subpath = `sandboxes/${sandboxId}/workspace`
  if (
    !isCanonicalV4Uuid(sandboxId) ||
    !isCanonicalV4Uuid(operationId) ||
    !isCanonicalV4Uuid(ownerRunnerId) ||
    !isCanonicalV4Uuid(volumeId) ||
    input.workspace?.mountPath !== '/workspace' ||
    input.workspace?.subpath !== subpath
  ) {
    throw new BadRequestException('Invalid missing-compute recovery request')
  }
  return { operationId, ownerRunnerId, workspace: { volumeId, mountPath: '/workspace', subpath } }
}

function assertSameRequest(expected: RecoverMissingComputeInput, actual: RecoverMissingComputeInput): void {
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

function assertExactPersistedIdentity(
  sandbox: Sandbox,
  request: RecoverMissingComputeInput,
  allowTransitional = false,
): void {
  assertLocalStorageBackend(sandbox)
  const allowedStates = allowTransitional
    ? [SandboxState.STARTED, SandboxState.STOPPED, SandboxState.ARCHIVED, SandboxState.CREATING, SandboxState.STARTING]
    : [SandboxState.STARTED, SandboxState.STOPPED, SandboxState.ARCHIVED]
  if (!allowedStates.includes(sandbox.state) || sandbox.pending || !hasExactPersistedIdentity(sandbox, request)) {
    throw identityConflict()
  }
}

function hasExactPersistedIdentity(sandbox: Sandbox, request: RecoverMissingComputeInput): boolean {
  let mounts
  try {
    mounts = buildRunnerVolumes(sandbox)
  } catch {
    return false
  }
  return (
    sandbox.storageBackend === SandboxStorageBackend.LOCAL &&
    sandbox.id === request.workspace.subpath.split('/')[1] &&
    sandbox.runnerId === request.ownerRunnerId &&
    mounts.length === 2 &&
    mounts.every(
      (mount) =>
        mount.volumeId === request.workspace.volumeId &&
        mount.subpath === request.workspace.subpath &&
        (mount.mountPath === '/workspace' || mount.mountPath === '/config'),
    )
  )
}

function assertRequestedOwnerAvailable(owner: Runner | null, ownerRunnerId: string): void {
  assertLocalOwnerAvailable({ runnerId: ownerRunnerId }, owner)
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
  if (error instanceof RunnerApiError) return error.statusCode === 404 || error.code === 'NOT_FOUND'
  if (!error || typeof error !== 'object') return false
  const value = error as { statusCode?: unknown; response?: { status?: unknown; data?: { statusCode?: unknown } } }
  return value.statusCode === 404 || value.response?.status === 404 || value.response?.data?.statusCode === 404
}

function identityConflict(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'Sandbox compute recovery identity or state conflicts with persisted state',
    code: 'identity_conflict',
    retryable: false,
  })
}

function workspaceMissing(): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    message: 'The original Runner-local workspace is missing',
    code: 'workspace_missing',
    retryable: false,
  })
}

function isWorkspaceMissingError(error: unknown): boolean {
  if (!(error instanceof ConflictException)) return false
  const response = error.getResponse()
  return Boolean(
    response &&
      typeof response === 'object' &&
      !Array.isArray(response) &&
      (response as Record<string, unknown>).code === 'workspace_missing',
  )
}
