/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import { v5 as uuidv5 } from 'uuid'
import { isCanonicalV4Uuid } from '../../common/utils/uuid'
import { LockCode, RedisLockProvider } from '../common/redis-lock.provider'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { buildRunnerVolumes, reportsLocalVolumeCapability } from '../local-volume/local-volume.contract'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { JobService } from './job.service'
import { RunnerService } from './runner.service'
import {
  SandboxWorkspaceDestructionOperationRecord,
  SandboxWorkspaceDestructionOperationStore,
} from './sandbox-workspace-destruction-operation.store'

const DESTRUCTION_LOCK_TTL_SECONDS = 15 * 60
const DESTRUCTION_LOCK_HEARTBEAT_MS = 60 * 1000
const JOB_POLL_INTERVAL_MS = 250
const JOB_POLL_ATTEMPTS = 15 * 60 * (1000 / JOB_POLL_INTERVAL_MS)

export interface DestroySandboxWorkspaceInput {
  operationId: string
  ownerRunnerId: string
  volumeId: string
  subpath: string
}

export interface SandboxWorkspaceDestructionResult {
  outcome: 'workspace_destroyed'
  operationId: string
  sandboxId: string
  ownerRunnerId: string
  computeDestroyed: true
  workspace: {
    volumeId: string
    mountPath: '/workspace'
    subpath: string
  }
  removalOutcome: 'removed' | 'already_absent'
}

export interface SandboxWorkspaceDestructionPendingResult {
  outcome: 'operation_in_progress'
  operationId: string
  sandboxId: string
}

export type SandboxWorkspaceDestructionResponse =
  | SandboxWorkspaceDestructionResult
  | SandboxWorkspaceDestructionPendingResult

@Injectable()
export class SandboxWorkspaceDestructionService {
  constructor(
    private readonly sandboxRepository: SandboxRepository,
    private readonly runnerService: RunnerService,
    private readonly jobService: JobService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly operationStore: SandboxWorkspaceDestructionOperationStore,
  ) {}

  async destroy(
    sandboxId: string,
    organizationId: string,
    input: DestroySandboxWorkspaceInput,
  ): Promise<SandboxWorkspaceDestructionResponse> {
    this.validateRequest(sandboxId, input)
    let sandbox = await this.loadSandbox(sandboxId, organizationId)
    this.validateStorageIdentity(sandbox, input)

    const replay = await this.operationStore.get(sandboxId, input.operationId)
    if (replay) {
      const replayed = this.replayOperation(replay, input)
      if (replayed.outcome !== 'operation_in_progress') return replayed
    }

    const lockKey = getStateChangeLockKey(sandboxId)
    const lockCode = new LockCode(input.operationId)
    if (!(await this.redisLockProvider.lock(lockKey, DESTRUCTION_LOCK_TTL_SECONDS, lockCode))) {
      if (replay) return this.replayOperation(replay, input)
      throw new ConflictException('Sandbox state change is already in progress')
    }
    let lockLost = false
    const heartbeat = setInterval(() => {
      this.redisLockProvider
        .refreshOwned(lockKey, DESTRUCTION_LOCK_TTL_SECONDS, lockCode)
        .then((refreshed) => {
          if (!refreshed) lockLost = true
        })
        .catch(() => {
          lockLost = true
        })
    }, DESTRUCTION_LOCK_HEARTBEAT_MS)
    heartbeat.unref()
    const assertLockOwned = async () => {
      if (lockLost || !(await this.redisLockProvider.refreshOwned(lockKey, DESTRUCTION_LOCK_TTL_SECONDS, lockCode))) {
        throw new ConflictException('Workspace destruction lock ownership was lost')
      }
    }

    try {
      sandbox = await this.loadSandbox(sandboxId, organizationId)
      this.validateStorageIdentity(sandbox, input)
      await this.loadOwner(input.ownerRunnerId)

      let resuming = replay?.status === 'running'
      if (!resuming && !(await this.operationStore.begin(sandboxId, input))) {
        const existing = await this.operationStore.get(sandboxId, input.operationId)
        if (!existing) throw new ConflictException('Workspace destruction operation is already in progress')
        const replayed = this.replayOperation(existing, input)
        if (replayed.outcome !== 'operation_in_progress') return replayed
        resuming = true
      }

      if (sandbox.state === SandboxState.STOPPED) {
        await assertLockOwned()
        const computeJob = await this.loadOrCreateOperationJob(
          uuidv5('destroy-compute', input.operationId),
          JobType.DESTROY_SANDBOX,
          sandbox,
          input,
          resuming,
        )
        await this.waitForJob(computeJob, JobType.DESTROY_SANDBOX, input)
      }

      await assertLockOwned()
      const workspaceJob = await this.loadOrCreateOperationJob(
        uuidv5('destroy-workspace', input.operationId),
        JobType.DESTROY_SANDBOX_WORKSPACE,
        sandbox,
        input,
        resuming,
      )
      const completed = await this.waitForJob(workspaceJob, JobType.DESTROY_SANDBOX_WORKSPACE, input)
      const removalOutcome = this.validateWorkspaceJobEvidence(completed, input, sandbox.id)
      await assertLockOwned()
      await this.sandboxRepository.updateWhere(sandbox.id, {
        updateData: {
          state: SandboxState.DESTROYED,
          desiredState: SandboxDesiredState.DESTROYED,
          pending: false,
          errorReason: null,
        },
        whereCondition: {
          state: sandbox.state,
          desiredState: sandbox.desiredState,
          pending: false,
          runnerId: sandbox.runnerId,
        },
      })
      const result: SandboxWorkspaceDestructionResult = {
        outcome: 'workspace_destroyed',
        operationId: input.operationId,
        sandboxId: sandbox.id,
        ownerRunnerId: input.ownerRunnerId,
        computeDestroyed: true,
        workspace: {
          volumeId: input.volumeId,
          mountPath: '/workspace',
          subpath: input.subpath,
        },
        removalOutcome,
      }
      await this.operationStore.complete(sandbox.id, input, result)
      return result
    } finally {
      clearInterval(heartbeat)
      await this.redisLockProvider.unlockOwned(lockKey, lockCode)
    }
  }

  private validateRequest(sandboxId: string, input: DestroySandboxWorkspaceInput): void {
    if (
      !isCanonicalV4Uuid(sandboxId) ||
      !isCanonicalV4Uuid(input.operationId) ||
      !isCanonicalV4Uuid(input.ownerRunnerId) ||
      !isCanonicalV4Uuid(input.volumeId) ||
      input.subpath !== `sandboxes/${sandboxId}/workspace`
    ) {
      throw new BadRequestException('Invalid exact workspace destruction request')
    }
  }

  private async loadSandbox(sandboxId: string, organizationId: string): Promise<Sandbox> {
    const sandbox = await this.sandboxRepository.findOneOrFail({
      where: { id: sandboxId, organizationId },
    })
    if (
      sandbox.pending ||
      (sandbox.state === SandboxState.STOPPED && sandbox.desiredState !== SandboxDesiredState.STOPPED) ||
      (sandbox.state === SandboxState.DESTROYED && sandbox.desiredState !== SandboxDesiredState.DESTROYED) ||
      (sandbox.state !== SandboxState.STOPPED && sandbox.state !== SandboxState.DESTROYED)
    ) {
      throw new ConflictException('Sandbox compute is not stopped for exact workspace destruction')
    }
    return sandbox
  }

  private validateStorageIdentity(sandbox: Sandbox, input: DestroySandboxWorkspaceInput): void {
    let volumes
    try {
      volumes = buildRunnerVolumes(sandbox)
    } catch {
      throw new ConflictException('Sandbox local workspace identity is invalid')
    }
    const workspace = volumes.find((volume) => volume.mountPath === '/workspace')
    if (
      !workspace ||
      workspace.volumeId !== input.volumeId ||
      workspace.subpath !== input.subpath ||
      (sandbox.runnerId !== null && sandbox.runnerId !== undefined && sandbox.runnerId !== input.ownerRunnerId) ||
      (sandbox.state === SandboxState.STOPPED && sandbox.runnerId !== input.ownerRunnerId)
    ) {
      throw new ConflictException('Sandbox local workspace identity does not match the destruction request')
    }
  }

  private async loadOwner(ownerRunnerId: string): Promise<Runner> {
    const owner = await this.runnerService.findOne(ownerRunnerId)
    if (
      !owner ||
      owner.id !== ownerRunnerId ||
      owner.apiVersion !== '2' ||
      owner.state !== RunnerState.READY ||
      !reportsLocalVolumeCapability(owner.serviceHealth)
    ) {
      throw new ServiceUnavailableException('Exact owner Runner is unavailable for workspace destruction')
    }
    return owner
  }

  private replayOperation(
    record: SandboxWorkspaceDestructionOperationRecord,
    input: DestroySandboxWorkspaceInput,
  ): SandboxWorkspaceDestructionResponse {
    if (
      record.ownerRunnerId !== input.ownerRunnerId ||
      record.volumeId !== input.volumeId ||
      record.subpath !== input.subpath
    ) {
      throw new BadRequestException('Workspace destruction operation does not match its original request')
    }
    if (record.status === 'complete') return record.result
    return {
      outcome: 'operation_in_progress',
      operationId: record.operationId,
      sandboxId: record.sandboxId,
    }
  }

  private async loadOrCreateOperationJob(
    jobId: string,
    type: JobType.DESTROY_SANDBOX | JobType.DESTROY_SANDBOX_WORKSPACE,
    sandbox: Sandbox,
    input: DestroySandboxWorkspaceInput,
    resuming: boolean,
  ): Promise<Job> {
    const existing = resuming ? await this.jobService.findOne(jobId) : null
    const job =
      existing ??
      (await this.jobService.createJob(null, type, input.ownerRunnerId, ResourceType.SANDBOX, sandbox.id, input, jobId))
    const payload = job.getPayload ? job.getPayload<DestroySandboxWorkspaceInput>() : JSON.parse(job.payload ?? 'null')
    if (
      job.id !== jobId ||
      job.type !== type ||
      job.runnerId !== input.ownerRunnerId ||
      job.resourceType !== ResourceType.SANDBOX ||
      job.resourceId !== sandbox.id ||
      !payload ||
      payload.operationId !== input.operationId ||
      payload.ownerRunnerId !== input.ownerRunnerId ||
      payload.volumeId !== input.volumeId ||
      payload.subpath !== input.subpath
    ) {
      throw new ConflictException('Runner job conflicts with workspace destruction operation')
    }
    return job
  }

  private async waitForJob(initial: Job, expectedType: JobType, input: DestroySandboxWorkspaceInput): Promise<Job> {
    for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt += 1) {
      const job = attempt === 0 ? initial : await this.jobService.findOne(initial.id)
      if (
        !job ||
        job.id !== initial.id ||
        job.type !== expectedType ||
        job.runnerId !== input.ownerRunnerId ||
        job.resourceType !== ResourceType.SANDBOX ||
        job.resourceId !== initial.resourceId
      ) {
        throw new ConflictException('Runner job identity changed during workspace destruction')
      }
      if (job.status === JobStatus.COMPLETED) return job
      if (job.status === JobStatus.FAILED) {
        throw new ConflictException('Runner rejected exact workspace destruction')
      }
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS))
    }
    throw new ServiceUnavailableException('Timed out waiting for exact workspace destruction')
  }

  private validateWorkspaceJobEvidence(
    job: Job,
    input: DestroySandboxWorkspaceInput,
    sandboxId: string,
  ): 'removed' | 'already_absent' {
    const evidence = job.getResultMetadata ? job.getResultMetadata() : JSON.parse(job.resultMetadata ?? 'null')
    if (
      !evidence ||
      evidence.operationId !== input.operationId ||
      evidence.sandboxId !== sandboxId ||
      evidence.ownerRunnerId !== input.ownerRunnerId ||
      evidence.volumeId !== input.volumeId ||
      evidence.subpath !== input.subpath ||
      (evidence.outcome !== 'removed' && evidence.outcome !== 'already_absent')
    ) {
      throw new ConflictException('Runner returned conflicting workspace destruction evidence')
    }
    return evidence.outcome
  }
}
