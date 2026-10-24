/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import axios from 'axios'
import { randomUUID } from 'node:crypto'
import { TypedConfigService } from '../../config/typed-config.service'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { OrganizationService } from '../../organization/services/organization.service'
import { isCanonicalV4Uuid } from '../../common/utils/uuid'
import { LockCode, RedisLockProvider } from '../common/redis-lock.provider'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { Snapshot } from '../entities/snapshot.entity'
import { SandboxConflictError } from '../errors/sandbox-conflict.error'
import { LocalSandboxStorageIdentityError } from '../errors/local-sandbox-storage-identity.error'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import {
  assertLocalOwnerAvailable,
  assertLocalStorageBackend,
  buildRunnerVolumes,
} from '../local-volume/local-volume.contract'
import { SandboxStartAction } from '../managers/sandbox-actions/sandbox-start.action'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { RunnerAdapter, RunnerAdapterFactory } from '../runner-adapter/runnerAdapter'
import { isRegistryBasedSandboxClass } from '../utils/sandbox-class.util'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { RunnerService } from './runner.service'
import { SandboxRebuildOperationStore, type SandboxRebuildOperationRecord } from './sandbox-rebuild-operation.store'
import { SnapshotService } from './snapshot.service'
import { withRebuildPreflightDeadline, REBUILD_PREFLIGHT_TIMEOUT_MS } from './sandbox-rebuild-operation.protocol'
import { rebuildOperationView } from './sandbox-rebuild-operation.view'

export interface RebuildSandboxInput {
  operationId: string
  targetSnapshot: string
}

export interface RebuiltSandboxResult {
  outcome: 'rebuilt'
  operationId: string
  sandboxId: string
  ownerRunnerId: string
  previousSnapshot: string
  targetSnapshot: string
}

export interface RebuildFailedPreviousRestoredResult {
  outcome: 'rebuild_failed_previous_restored'
  operationId: string
  sandboxId: string
  ownerRunnerId: string
  previousSnapshot: string
  targetSnapshot: string
}

export interface RebuildPreflightFailedResult {
  outcome: 'rebuild_preflight_failed'
  operationId: string
  sandboxId: string
  ownerRunnerId: string
  previousSnapshot: string
  targetSnapshot: string
}

export interface RebuildFailedRollbackFailedResult {
  outcome: 'rebuild_failed_rollback_failed'
  operationId: string
  sandboxId: string
  ownerRunnerId: string
  previousSnapshot: string
  targetSnapshot: string
}

export interface RebuildOperationPendingResult {
  outcome: 'operation_in_progress' | 'operation_outcome_unknown'
  operationId: string
  sandboxId: string
  targetSnapshot: string
}

export type LocalSandboxRebuildResult =
  | RebuiltSandboxResult
  | RebuildPreflightFailedResult
  | RebuildFailedPreviousRestoredResult
  | RebuildFailedRollbackFailedResult
  | RebuildOperationPendingResult

export const LOCAL_SANDBOX_REBUILD_ROLLBACK_FAILED_MESSAGE =
  'Local sandbox rebuild and rollback failed; workspace Volume was preserved'
const REBUILD_LOCK_TTL_SECONDS = 5 * 60
const REBUILD_LOCK_HEARTBEAT_MS = 60 * 1000

interface ResolvedRebuildSnapshot {
  name: string
  ref: string
  entrypoint?: string[]
  registry?: DockerRegistry
  snapshot?: Snapshot
}

@Injectable()
export class SandboxRebuildService {
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
    private readonly operationStore: SandboxRebuildOperationStore,
  ) {}

  async getEligibility(sandboxId: string, organizationId: string) {
    if (!isCanonicalV4Uuid(sandboxId)) throw new BadRequestException('Invalid sandbox identity')
    const key = getStateChangeLockKey(sandboxId)
    const code = new LockCode(randomUUID())
    if (!(await this.redisLockProvider.lock(key, 30, code))) {
      throw new ConflictException({ code: 'remote_operation_unresolved' })
    }
    try {
      const sandbox = await this.sandboxRepository.findOneOrFail({ where: { id: sandboxId, organizationId } })
      if (sandbox.state !== SandboxState.STARTED || sandbox.desiredState !== SandboxDesiredState.STARTED || sandbox.pending || !sandbox.runnerId || !sandbox.snapshot?.trim()) {
        throw new ConflictException({ code: 'control_plane_inconsistent' })
      }
      if (sandbox.name.startsWith('DESTROYED_')) {
        // A retained tombstone name needs operator review, not automatic rename.
        throw new ConflictException({ code: 'historical_identity_requires_review' })
      }
      if (await this.operationStore.hasActive(sandboxId) || await this.sandboxRepository.hasIncompleteLifecycleJobs(sandboxId)) {
        throw new ConflictException({ code: 'remote_operation_unresolved' })
      }
      assertLocalStorageBackend(sandbox)
      const owner = await this.runnerService.findOne(sandbox.runnerId)
      const ownerRunnerId = assertLocalOwnerAvailable(sandbox, owner)
      if (!owner?.apiUrl) throw new ServiceUnavailableException('Runner inspection is unavailable')
      const volumes = buildRunnerVolumes(sandbox)
      const previousRuntime = await this.resolveSnapshot(sandbox, sandbox.snapshot, owner)
      const workspace = volumes.find(volume => volume.mountPath === '/workspace')
      if (!workspace) throw new LocalSandboxStorageIdentityError()
      // This endpoint inspects actual binds/devices. It never calls start or the
      // existing start verifier's force-stop-on-invalid-mount path.
      let runtime: Record<string, unknown>
      try {
        const response = await axios.post(`${owner.apiUrl.replace(/\/+$/, '')}/sandboxes/${sandboxId}/rebuild-inspect`,
          { volumes }, { headers: { Authorization: `Bearer ${owner.apiKey}` }, timeout: 10000 })
        runtime = response.data
      } catch {
        // Axios errors retain Authorization/config and remote response bodies.
        throw new ServiceUnavailableException('Runner workspace inspection is unavailable')
      }
      if (runtime?.verified !== true || runtime.sandboxId !== sandboxId || runtime.image !== previousRuntime.ref || typeof runtime.containerId !== 'string' || !runtime.containerId || typeof runtime.created !== 'string' || !runtime.created) {
        throw new ServiceUnavailableException('Runner workspace evidence is unavailable')
      }
      if (!(await this.redisLockProvider.refreshOwned(key, 30, code))) throw new SandboxConflictError()
      const current = await this.sandboxRepository.findOneOrFail({ where: { id: sandboxId, organizationId } })
      if (current.state !== sandbox.state || current.desiredState !== sandbox.desiredState || current.pending || current.runnerId !== ownerRunnerId || current.snapshot !== sandbox.snapshot) {
        throw new ConflictException({ code: 'control_plane_inconsistent' })
      }
      return { sandboxId, organizationId, ownerRunnerId, snapshot: sandbox.snapshot,
        state: sandbox.state, desiredState: sandbox.desiredState, pending: false,
        workspace: { volumeId: workspace.volumeId, mountPath: workspace.mountPath, subpath: workspace.subpath },
        runtime: { verified: true, containerId: runtime.containerId, created: runtime.created } }
    } finally { await this.redisLockProvider.unlockOwned(key, code) }
  }

  async getOperation(sandboxId: string, organizationId: string, operationId: string) {
    if (!isCanonicalV4Uuid(sandboxId) || !isCanonicalV4Uuid(operationId)) {
      throw new BadRequestException('Invalid rebuild operation identity')
    }
    // Preserve tenant scoping even when operation evidence is retained in Redis.
    await this.sandboxRepository.findOneOrFail({ where: { id: sandboxId, organizationId } })
    const record = await this.operationStore.get(sandboxId, operationId)
    if (!record) throw new NotFoundException('Rebuild operation evidence is unavailable')
    try {
      const view = rebuildOperationView(record, sandboxId, operationId)
      if (view.status === 'running') {
        const lock = await this.redisLockProvider.getCode(getStateChangeLockKey(sandboxId))
        return { ...view, executionState: lock?.getCode() === operationId ? 'running' : 'outcome_unknown' }
      }
      return view
    } catch {
      throw new ServiceUnavailableException('Rebuild operation evidence could not be verified')
    }
  }

  async reconcilePreparation(sandboxId: string, organizationId: string, operationId: string, targetSnapshot: string) {
    if (
      !isCanonicalV4Uuid(sandboxId) ||
      !isCanonicalV4Uuid(operationId) ||
      typeof targetSnapshot !== 'string' ||
      !targetSnapshot.trim()
    ) {
      throw new BadRequestException('Invalid rebuild operation identity')
    }
    await this.sandboxRepository.findOneOrFail({ where: { id: sandboxId, organizationId } })
    const record = await this.operationStore.reconcilePreparation(
      sandboxId,
      operationId,
      targetSnapshot,
      getStateChangeLockKey(sandboxId),
    )
    if (!record || record.targetSnapshot !== targetSnapshot)
      throw new NotFoundException('Rebuild operation evidence is unavailable')
    return rebuildOperationView(record, sandboxId, operationId)
  }

  async rebuild(
    sandboxId: string,
    organizationId: string,
    input: RebuildSandboxInput,
  ): Promise<LocalSandboxRebuildResult> {
    if (!isCanonicalV4Uuid(sandboxId) || !isCanonicalV4Uuid(input.operationId) || !input.targetSnapshot.trim()) {
      throw new BadRequestException('Invalid local sandbox rebuild request')
    }
    const targetSnapshotName = input.targetSnapshot.trim()
    const replay = await this.operationStore.get(sandboxId, input.operationId)
    if (replay) {
      return this.replayOperation(replay, targetSnapshotName)
    }

    const lockKey = getStateChangeLockKey(sandboxId)
    const lockCode = new LockCode(input.operationId)
    if (!(await this.redisLockProvider.lock(lockKey, REBUILD_LOCK_TTL_SECONDS, lockCode))) {
      throw new SandboxConflictError()
    }
    let lockLost = false
    let expectedOwner: string | undefined
    let expectedSnapshot: string | undefined
    let expectedState = SandboxState.STARTED
    const heartbeat = setInterval(() => {
      this.redisLockProvider
        .refreshOwned(lockKey, REBUILD_LOCK_TTL_SECONDS, lockCode)
        .then((refreshed) => {
          if (!refreshed) lockLost = true
        })
        .catch(() => {
          lockLost = true
        })
    }, REBUILD_LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    const assertLockOwned = async () => {
      if (lockLost || !(await this.redisLockProvider.refreshOwned(lockKey, REBUILD_LOCK_TTL_SECONDS, lockCode))) {
        throw new SandboxConflictError()
      }
      if (expectedOwner) {
        const current = await this.sandboxRepository.findOneOrFail({ where: { id: sandboxId, organizationId } })
        if (current.runnerId !== expectedOwner || current.state !== expectedState
          || current.desiredState !== SandboxDesiredState.STARTED || current.pending
          || current.snapshot !== expectedSnapshot) throw new SandboxConflictError()
      }
    }

    try {
      const sandbox = await this.sandboxRepository.findOneOrFail({
        where: { id: sandboxId, organizationId },
      })
      assertLocalStorageBackend(sandbox)
      if (
        sandbox.state !== SandboxState.STARTED ||
        sandbox.desiredState !== SandboxDesiredState.STARTED ||
        sandbox.pending
      ) {
        throw new SandboxConflictError()
      }

      const owner = sandbox.runnerId ? await this.runnerService.findOne(sandbox.runnerId) : null
      const ownerRunnerId = assertLocalOwnerAvailable(sandbox, owner)
      if (!owner) {
        throw new SandboxConflictError()
      }
      const previousSnapshot = sandbox.snapshot?.trim()
      if (!previousSnapshot) {
        throw new SandboxConflictError()
      }

      const runnerAdapter = await this.runnerAdapterFactory.create(owner)
      runnerAdapter.setRebuildOperation?.(input.operationId, assertLockOwned)
      expectedOwner = ownerRunnerId
      expectedSnapshot = previousSnapshot
      const organization = await this.organizationService.findOne(sandbox.organizationId)
      let volumes
      try {
        volumes = buildRunnerVolumes(sandbox)
      } catch {
        throw new LocalSandboxStorageIdentityError()
      }
      const metadata: Record<string, string> = {
        ...organization?.sandboxMetadata,
        sandboxName: sandbox.name,
        volumes: JSON.stringify(volumes),
      }
      if (sandbox.domainAllowList) {
        metadata.domainAllowList = sandbox.domainAllowList
      }

      if (
        !(await this.operationStore.begin(sandbox.id, input.operationId, targetSnapshotName, {
          previousSnapshot,
          ownerRunnerId,
        }))
      ) {
        const existing = await this.operationStore.get(sandbox.id, input.operationId)
        if (!existing) throw new SandboxConflictError()
        return this.replayOperation(existing, targetSnapshotName)
      }

      const preflightDeadline = Date.now() + REBUILD_PREFLIGHT_TIMEOUT_MS

      // Starting an already-running sandbox is the Runner's existing read/verify
      // boundary for canonical bind sources, mount devices, and daemon readiness.
      try {
        await withRebuildPreflightDeadline(
          async () => {
            await assertLockOwned()
            await runnerAdapter.startSandbox(sandbox.id, sandbox.authToken, metadata)
            await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.STARTED)
          },
          Math.max(1, preflightDeadline - Date.now()),
        )
      } catch {
        await this.operationStore.complete(sandbox.id, input.operationId, targetSnapshotName, {
          outcome: 'rebuild_preflight_failed',
          operationId: input.operationId,
          sandboxId: sandbox.id,
          ownerRunnerId,
          previousSnapshot,
          targetSnapshot: targetSnapshotName,
        })
        throw new LocalSandboxStorageIdentityError()
      }

      let previousRuntime: ResolvedRebuildSnapshot
      let targetSnapshot: Snapshot
      let targetRuntime: ResolvedRebuildSnapshot
      try {
        const resolved = await withRebuildPreflightDeadline(
          async () => {
            const previousRuntime = await this.resolveSnapshot(sandbox, previousSnapshot, owner)
            const targetSnapshot = await this.snapshotService.getSnapshotByName(
              targetSnapshotName,
              sandbox.organizationId,
            )
            const targetRuntime = await this.resolveSnapshot(sandbox, targetSnapshot.name, owner, targetSnapshot)
            await this.ensureSnapshotAvailable(runnerAdapter, previousRuntime, owner)
            await this.ensureSnapshotAvailable(runnerAdapter, targetRuntime, owner)
            return { previousRuntime, targetSnapshot, targetRuntime }
          },
          Math.max(1, preflightDeadline - Date.now()),
        )
        previousRuntime = resolved.previousRuntime
        targetSnapshot = resolved.targetSnapshot
        targetRuntime = resolved.targetRuntime
      } catch {
        const result: RebuildPreflightFailedResult = {
          outcome: 'rebuild_preflight_failed',
          operationId: input.operationId,
          sandboxId: sandbox.id,
          ownerRunnerId,
          previousSnapshot,
          targetSnapshot: targetSnapshotName,
        }
        // A lost HTTP response must not erase proof that compute was unchanged.
        await this.operationStore.complete(sandbox.id, input.operationId, targetSnapshotName, result)
        return result
      }
      await assertLockOwned()

      if (
        !(await this.operationStore.beginMutation(
          sandbox.id,
          input.operationId,
          targetSnapshot.name,
          lockKey,
          lockCode.getCode(),
        ))
      ) {
        const existing = await this.operationStore.get(sandbox.id, input.operationId)
        if (!existing) throw new SandboxConflictError()
        return this.replayOperation(existing, targetSnapshot.name)
      }

      await assertLockOwned()
      await runnerAdapter.destroySandbox(sandbox.id)
      await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.DESTROYED)
      await assertLockOwned()
      const targetSandbox = Object.assign(new Sandbox(), sandbox, {
        env: {
          ...sandbox.env,
          KORTIX_REBUILD_REQUIRED: 'true',
          KORTIX_REBUILD_OPERATION_ID: input.operationId,
        },
      })
      let result: RebuiltSandboxResult | RebuildFailedPreviousRestoredResult | RebuildFailedRollbackFailedResult
      try {
        await assertLockOwned()
        await this.createSandboxGeneration(
          runnerAdapter,
          owner,
          targetSandbox,
          targetRuntime,
          organization?.sandboxMetadata,
        )
        await assertLockOwned()
        await runnerAdapter.startSandbox(sandbox.id, sandbox.authToken, metadata)
        await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.STARTED)

        await this.sandboxRepository.updateWhere(sandbox.id, {
          updateData: { snapshot: targetSnapshot.name },
          whereCondition: {
            state: SandboxState.STARTED,
            desiredState: SandboxDesiredState.STARTED,
            pending: false,
            runnerId: ownerRunnerId,
          },
        })
        expectedSnapshot = targetSnapshot.name

        result = {
          outcome: 'rebuilt',
          operationId: input.operationId,
          sandboxId: sandbox.id,
          ownerRunnerId,
          previousSnapshot,
          targetSnapshot: targetSnapshot.name,
        }
      } catch (targetError) {
        if (targetError instanceof SandboxConflictError) throw targetError
        try {
          await assertLockOwned()
          await this.destroySandboxIfPresent(runnerAdapter, sandbox.id)
          await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.DESTROYED)
          await assertLockOwned()
          await this.createSandboxGeneration(
            runnerAdapter,
            owner,
            sandbox,
            previousRuntime,
            organization?.sandboxMetadata,
          )
          await assertLockOwned()
          await runnerAdapter.startSandbox(sandbox.id, sandbox.authToken, metadata)
          await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.STARTED)
          result = {
            outcome: 'rebuild_failed_previous_restored',
            operationId: input.operationId,
            sandboxId: sandbox.id,
            ownerRunnerId,
            previousSnapshot,
            targetSnapshot: targetSnapshot.name,
          }
        } catch (rollbackError) {
          if (rollbackError instanceof SandboxConflictError) throw rollbackError
          await assertLockOwned()
          await this.sandboxRepository.updateWhere(sandbox.id, {
            updateData: {
              state: SandboxState.ERROR,
              errorReason: LOCAL_SANDBOX_REBUILD_ROLLBACK_FAILED_MESSAGE,
              recoverable: true,
            },
            whereCondition: {
              state: SandboxState.STARTED,
              desiredState: SandboxDesiredState.STARTED,
              pending: false,
              runnerId: ownerRunnerId,
            },
          })
          expectedState = SandboxState.ERROR
          result = {
            outcome: 'rebuild_failed_rollback_failed',
            operationId: input.operationId,
            sandboxId: sandbox.id,
            ownerRunnerId,
            previousSnapshot,
            targetSnapshot: targetSnapshot.name,
          }
        }
      }
      await assertLockOwned()
      await this.operationStore.complete(sandbox.id, input.operationId, targetSnapshot.name, result)
      return result
    } finally {
      clearInterval(heartbeat)
      await this.redisLockProvider.unlockOwned(lockKey, lockCode)
    }
  }

  private async replayOperation(
    record: SandboxRebuildOperationRecord,
    targetSnapshot: string,
  ): Promise<LocalSandboxRebuildResult> {
    if (record.targetSnapshot !== targetSnapshot) {
      throw new BadRequestException('Rebuild operation target does not match its original request')
    }
    if (record.status === 'complete') {
      return record.result
    }
    return {
      outcome: (await this.redisLockProvider.isLocked(getStateChangeLockKey(record.sandboxId)))
        ? 'operation_in_progress'
        : 'operation_outcome_unknown',
      operationId: record.operationId,
      sandboxId: record.sandboxId,
      targetSnapshot: record.targetSnapshot,
    }
  }

  private async resolveSnapshot(
    sandbox: Sandbox,
    name: string,
    owner: Runner,
    snapshot?: Snapshot,
  ): Promise<ResolvedRebuildSnapshot> {
    if (name === sandbox.snapshot && sandbox.buildInfo) {
      return {
        name,
        ref: sandbox.buildInfo.snapshotRef,
        entrypoint: this.snapshotService.getEntrypointFromDockerfile(sandbox.buildInfo.dockerfileContent),
      }
    }

    const resolved = snapshot ?? (await this.snapshotService.getSnapshotByName(name, sandbox.organizationId))
    const registry = isRegistryBasedSandboxClass(resolved.sandboxClass)
      ? ((await this.dockerRegistryService.findInternalRegistryBySnapshotRef(resolved.ref, owner.region)) ?? undefined)
      : undefined
    return {
      name: resolved.name,
      ref: resolved.ref,
      entrypoint: resolved.entrypoint,
      registry,
      snapshot: resolved,
    }
  }

  private async ensureSnapshotAvailable(
    runnerAdapter: Awaited<ReturnType<RunnerAdapterFactory['create']>>,
    resolved: ResolvedRebuildSnapshot,
    owner: Runner,
  ): Promise<void> {
    if (await runnerAdapter.snapshotExists(resolved.ref)) {
      return
    }
    if (!resolved.snapshot) {
      throw new SandboxConflictError()
    }
    await this.sandboxStartAction.pullSnapshotToRunner(resolved.snapshot, owner)
  }

  private async createSandboxGeneration(
    runnerAdapter: RunnerAdapter,
    owner: Runner,
    sandbox: Sandbox,
    resolved: ResolvedRebuildSnapshot,
    sandboxMetadata?: Record<string, string>,
  ): Promise<void> {
    await runnerAdapter.createSandbox(
      sandbox,
      resolved.ref,
      resolved.registry,
      resolved.entrypoint,
      {
        ...sandboxMetadata,
        sandboxName: sandbox.name,
      },
      this.configService.get('otelCollector.endpointUrl'),
    )
    await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.STARTED)
  }

  private async destroySandboxIfPresent(runnerAdapter: RunnerAdapter, sandboxId: string): Promise<void> {
    try {
      await runnerAdapter.destroySandbox(sandboxId)
    } catch (error) {
      const runnerError = error as {
        statusCode?: number
        response?: {
          status?: number
          data?: { statusCode?: number; message?: unknown }
        }
      }
      const status = runnerError.statusCode ?? runnerError.response?.data?.statusCode ?? runnerError.response?.status
      const message = runnerError.response?.data?.message
      const alreadyDestroyed =
        status === 404 ||
        (status === 400 && typeof message === 'string' && message.includes('Sandbox already destroyed'))
      if (!alreadyDestroyed) throw error
    }
  }

  private async waitForRunnerState(
    runnerAdapter: RunnerAdapter,
    owner: Runner,
    sandboxId: string,
    expected: SandboxState,
  ): Promise<void> {
    if (owner.apiVersion !== '2') return

    const attempts = 300
    for (let attempt = 0; attempt < attempts; attempt++) {
      const info = await runnerAdapter.sandboxInfo(sandboxId)
      if (info.state === expected) return
      if (info.state === SandboxState.ERROR) {
        throw new Error('V2 Runner sandbox transition failed')
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('V2 Runner sandbox transition timed out')
  }
}
