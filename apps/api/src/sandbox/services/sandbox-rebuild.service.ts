/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, Injectable } from '@nestjs/common'
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

      // Starting an already-running sandbox is the Runner's existing read/verify
      // boundary for canonical bind sources, mount devices, and daemon readiness.
      try {
        await runnerAdapter.startSandbox(sandbox.id, sandbox.authToken, metadata)
        await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.STARTED)
      } catch {
        throw new LocalSandboxStorageIdentityError()
      }

      let previousRuntime: ResolvedRebuildSnapshot
      let targetSnapshot: Snapshot
      let targetRuntime: ResolvedRebuildSnapshot
      try {
        previousRuntime = await this.resolveSnapshot(sandbox, previousSnapshot, owner)
        targetSnapshot = await this.snapshotService.getSnapshotByName(targetSnapshotName, sandbox.organizationId)
        targetRuntime = await this.resolveSnapshot(sandbox, targetSnapshot.name, owner, targetSnapshot)
        await this.ensureSnapshotAvailable(runnerAdapter, previousRuntime, owner)
        await this.ensureSnapshotAvailable(runnerAdapter, targetRuntime, owner)
      } catch {
        return {
          outcome: 'rebuild_preflight_failed',
          operationId: input.operationId,
          sandboxId: sandbox.id,
          ownerRunnerId,
          previousSnapshot,
          targetSnapshot: targetSnapshotName,
        }
      }
      await assertLockOwned()

      if (!(await this.operationStore.begin(sandbox.id, input.operationId, targetSnapshot.name))) {
        const existing = await this.operationStore.get(sandbox.id, input.operationId)
        if (!existing) throw new SandboxConflictError()
        return this.replayOperation(existing, targetSnapshot.name)
      }

      await runnerAdapter.destroySandbox(sandbox.id)
      await this.waitForRunnerState(runnerAdapter, owner, sandbox.id, SandboxState.DESTROYED)
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
          await this.createSandboxGeneration(
            runnerAdapter,
            owner,
            sandbox,
            previousRuntime,
            organization?.sandboxMetadata,
          )
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
        } catch {
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
