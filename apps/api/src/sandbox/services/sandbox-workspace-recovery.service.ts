/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common'
import type { CreateSandboxDTO, RegistryDTO } from '@daytona/runner-api-client'
import { v5 as uuidv5 } from 'uuid'
import { TypedConfigService } from '../../config/typed-config.service'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { OrganizationService } from '../../organization/services/organization.service'
import { isCanonicalV4Uuid } from '../../common/utils/uuid'
import { LockCode, RedisLockProvider } from '../common/redis-lock.provider'
import { Job } from '../entities/job.entity'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { Snapshot } from '../entities/snapshot.entity'
import type { SandboxVolume } from '../dto/sandbox.dto'
import { JobStatus } from '../enums/job-status.enum'
import { JobType } from '../enums/job-type.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { RunnerState } from '../enums/runner-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxStorageBackend } from '../enums/sandbox-storage-backend.enum'
import {
  buildRunnerVolumes,
  reportsLocalVolumeCapability,
  type LocalVolumeMount,
} from '../local-volume/local-volume.contract'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { isRegistryBasedSandboxClass } from '../utils/sandbox-class.util'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { JobService } from './job.service'
import { RunnerService } from './runner.service'
import {
  SandboxWorkspaceRecoveryOperationRecord,
  SandboxWorkspaceRecoveryOperationStore,
} from './sandbox-workspace-recovery-operation.store'
import { SnapshotService } from './snapshot.service'
import { VolumeService } from './volume.service'

const RECOVERY_LOCK_TTL_SECONDS = 15 * 60
const RECOVERY_LOCK_HEARTBEAT_MS = 60 * 1000
const JOB_POLL_INTERVAL_MS = 250
const JOB_POLL_ATTEMPTS = 15 * 60 * (1000 / JOB_POLL_INTERVAL_MS)

export interface RecoverSandboxWorkspaceInput {
  operationId: string
  ownerRunnerId: string
  workspace: { volumeId: string; mountPath: '/workspace'; subpath: string }
}

export interface SandboxWorkspaceRecoveryResult {
  outcome: 'recovered'
  operationId: string
  sandboxId: string
  externalId: string
  ownerRunnerId: string
  status: 'running'
  workspace: RecoverSandboxWorkspaceInput['workspace']
}

export interface SandboxWorkspaceRecoveryPendingResult {
  outcome: 'operation_in_progress'
  operationId: string
  sandboxId: string
}

export type SandboxWorkspaceRecoveryResponse = SandboxWorkspaceRecoveryResult | SandboxWorkspaceRecoveryPendingResult

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
    private readonly snapshotService: SnapshotService,
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly organizationService: OrganizationService,
    private readonly configService: TypedConfigService,
    private readonly volumeService: VolumeService,
    private readonly jobService: JobService,
    private readonly redisLockProvider: RedisLockProvider,
    private readonly operationStore: SandboxWorkspaceRecoveryOperationStore,
  ) {}

  async recover(
    sandboxId: string,
    organizationId: string,
    input: RecoverSandboxWorkspaceInput,
  ): Promise<SandboxWorkspaceRecoveryResponse> {
    this.validateRequest(sandboxId, input)
    let sandbox = await this.loadSandbox(sandboxId, organizationId)
    const replay = await this.operationStore.get(sandboxId, input.operationId)
    if (replay) {
      const replayed = this.replayOperation(replay, input, sandbox)
      if (replayed.outcome !== 'operation_in_progress') return replayed
    }
    if (!replay) {
      this.validateRecoverableState(sandbox)
      this.validateOriginalIdentity(sandbox)
    }

    const lockKey = getStateChangeLockKey(sandboxId)
    const lockCode = new LockCode(input.operationId)
    if (!(await this.redisLockProvider.lock(lockKey, RECOVERY_LOCK_TTL_SECONDS, lockCode))) {
      if (replay) return this.replayOperation(replay, input, sandbox)
      throw new ConflictException('Sandbox state change is already in progress')
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
        throw new ConflictException('Workspace recovery lock ownership was lost')
      }
    }

    try {
      sandbox = await this.loadSandbox(sandboxId, organizationId)
      if (replay?.status === 'running' && this.isExactRecoveredSandbox(sandbox, input)) {
        await assertLockOwned()
        await this.volumeService.registerRestoredLocalVolume(input.workspace.volumeId, sandbox.organizationId)
        const result = this.recoveredResult(sandbox.id, input)
        await this.operationStore.complete(sandbox.id, input, result)
        return result
      }
      this.validateRecoverableState(sandbox)
      const originalWorkspace = this.validateOriginalIdentity(sandbox)
      if (originalWorkspace.volumeId === input.workspace.volumeId) {
        throw new ConflictException('Recovery replacement must differ from the original physical Volume')
      }
      const owner = await this.loadOwner(input.ownerRunnerId)
      if (owner.region !== sandbox.region) {
        throw new ConflictException('Exact owner Runner region does not match the recovery sandbox')
      }
      const snapshot = await this.resolveSnapshot(sandbox, owner)
      const organization = await this.organizationService.findOne(sandbox.organizationId)
      let resuming = replay?.status === 'running'
      if (!resuming && !(await this.operationStore.begin(sandboxId, input))) {
        const existing = await this.operationStore.get(sandboxId, input.operationId)
        if (!existing) throw new ConflictException('Workspace recovery operation is already in progress')
        const replayed = this.replayOperation(existing, input, sandbox)
        if (replayed.outcome !== 'operation_in_progress') return replayed
        resuming = true
      }

      const createPayload = this.buildCreatePayload(sandbox, snapshot, input, organization?.sandboxMetadata)
      const jobPayload = {
        operationId: input.operationId,
        ownerRunnerId: owner.id,
        originalVolumeId: originalWorkspace.volumeId,
        originalVolumeSubpath: originalWorkspace.subpath,
        sandbox: createPayload,
      }
      await assertLockOwned()
      const jobId = uuidv5('recover-workspace', input.operationId)
      const existingJob = resuming ? await this.jobService.findOne(jobId) : null
      const job =
        existingJob ??
        (await this.jobService.createJob(
          null,
          JobType.RECOVER_SANDBOX_WORKSPACE,
          owner.id,
          ResourceType.SANDBOX,
          sandbox.id,
          jobPayload,
          jobId,
        ))
      this.validateRecoveryJob(job, jobId, sandbox.id, input, originalWorkspace, createPayload)
      const completed = await this.waitForJob(job, input)
      const daemonVersion = this.validateJobEvidence(completed, sandbox.id, input)
      const replacementVolumes = this.replacementSandboxVolumes(input)
      await assertLockOwned()
      await this.volumeService.registerRestoredLocalVolume(input.workspace.volumeId, sandbox.organizationId)
      const updated = await this.sandboxRepository.updateWhere(sandbox.id, {
        updateData: {
          state: SandboxState.STARTED,
          desiredState: SandboxDesiredState.STARTED,
          pending: false,
          runnerId: owner.id,
          volumes: replacementVolumes,
          errorReason: null,
          recoverable: false,
          daemonVersion,
        },
        whereCondition: {
          state: sandbox.state,
          desiredState: sandbox.desiredState,
          pending: false,
          runnerId: sandbox.runnerId,
        },
      })
      if (!this.isExactRecoveredSandbox(updated, input)) {
        throw new ConflictException('Recovered sandbox identity changed during activation')
      }
      const result = this.recoveredResult(sandbox.id, input)
      await this.operationStore.complete(sandbox.id, input, result)
      return result
    } finally {
      clearInterval(heartbeat)
      await this.redisLockProvider.unlockOwned(lockKey, lockCode)
    }
  }

  private validateRequest(sandboxId: string, input: RecoverSandboxWorkspaceInput): void {
    if (
      !isCanonicalV4Uuid(sandboxId) ||
      !isCanonicalV4Uuid(input.operationId) ||
      !isCanonicalV4Uuid(input.ownerRunnerId) ||
      !isCanonicalV4Uuid(input.workspace?.volumeId) ||
      input.workspace?.mountPath !== '/workspace' ||
      input.workspace?.subpath !== `sandboxes/${sandboxId}/workspace`
    ) {
      throw new BadRequestException('Invalid exact workspace recovery request')
    }
  }

  private async loadSandbox(sandboxId: string, organizationId: string): Promise<Sandbox> {
    return this.sandboxRepository.findOneOrFail({ where: { id: sandboxId, organizationId } })
  }

  private validateRecoverableState(sandbox: Sandbox): void {
    if (
      sandbox.pending ||
      (sandbox.state === SandboxState.STOPPED && sandbox.desiredState !== SandboxDesiredState.STOPPED) ||
      (sandbox.state === SandboxState.DESTROYED && sandbox.desiredState !== SandboxDesiredState.DESTROYED) ||
      (sandbox.state !== SandboxState.STOPPED && sandbox.state !== SandboxState.DESTROYED)
    ) {
      throw new ConflictException('Sandbox is not in a recoverable compute state')
    }
  }

  private validateOriginalIdentity(sandbox: Sandbox): LocalVolumeMount & { subpath: string } {
    try {
      const workspace = buildRunnerVolumes(sandbox).find((volume) => volume.mountPath === '/workspace')
      if (!workspace?.subpath) throw new Error('missing original workspace')
      return workspace as LocalVolumeMount & { subpath: string }
    } catch {
      throw new ConflictException('Original local workspace identity is invalid')
    }
  }

  private async loadOwner(ownerRunnerId: string): Promise<Runner> {
    const owner = await this.runnerService.findOne(ownerRunnerId)
    if (
      !owner ||
      owner.id !== ownerRunnerId ||
      owner.apiVersion !== '2' ||
      owner.state !== RunnerState.READY ||
      owner.unschedulable ||
      owner.draining ||
      !reportsLocalVolumeCapability(owner.serviceHealth)
    ) {
      throw new ServiceUnavailableException('Exact owner Runner is unavailable for workspace recovery')
    }
    return owner
  }

  private async resolveSnapshot(sandbox: Sandbox, owner: Runner): Promise<ResolvedRecoverySnapshot> {
    if (sandbox.buildInfo?.snapshotRef) {
      return {
        ref: sandbox.buildInfo.snapshotRef,
        entrypoint: this.snapshotService.getEntrypointFromDockerfile(sandbox.buildInfo.dockerfileContent),
      }
    }
    const snapshot: Snapshot = await this.snapshotService.getSnapshotByName(sandbox.snapshot, sandbox.organizationId)
    const registry = isRegistryBasedSandboxClass(snapshot.sandboxClass)
      ? ((await this.dockerRegistryService.findInternalRegistryBySnapshotRef(snapshot.ref, owner.region)) ?? undefined)
      : undefined
    return { ref: snapshot.ref, entrypoint: snapshot.entrypoint, registry }
  }

  private buildCreatePayload(
    sandbox: Sandbox,
    snapshot: ResolvedRecoverySnapshot,
    input: RecoverSandboxWorkspaceInput,
    sandboxMetadata?: Record<string, string>,
  ): CreateSandboxDTO {
    const registry: RegistryDTO | undefined = snapshot.registry
      ? {
          project: snapshot.registry.project,
          url: snapshot.registry.url.replace(/^(https?:\/\/)/, ''),
          username: snapshot.registry.username,
          password: snapshot.registry.password,
        }
      : undefined
    const volumes = [
      { ...input.workspace, backend: SandboxStorageBackend.LOCAL },
      { ...input.workspace, mountPath: '/config', backend: SandboxStorageBackend.LOCAL },
    ]
    return {
      id: sandbox.id,
      name: sandbox.name,
      userId: sandbox.organizationId,
      snapshot: snapshot.ref,
      osUser: sandbox.osUser,
      cpuQuota: sandbox.cpu,
      gpuQuota: sandbox.gpu,
      memoryQuota: sandbox.mem,
      storageQuota: sandbox.disk,
      env: sandbox.env,
      registry,
      entrypoint: snapshot.entrypoint,
      volumes,
      networkBlockAll: sandbox.networkBlockAll,
      networkAllowList: sandbox.networkAllowList,
      domainAllowList: sandbox.domainAllowList,
      metadata: { ...sandboxMetadata, sandboxName: sandbox.name },
      authToken: sandbox.authToken,
      otelEndpoint: this.configService.get('otelCollector.endpointUrl'),
      organizationId: sandbox.organizationId,
      regionId: sandbox.region,
      linkedSandboxId: sandbox.linkedSandboxId ?? undefined,
      sandboxClass: sandbox.sandboxClass,
    }
  }

  private replacementSandboxVolumes(input: RecoverSandboxWorkspaceInput): SandboxVolume[] {
    return [{ ...input.workspace }, { ...input.workspace, mountPath: '/config' }]
  }

  private replayOperation(
    record: SandboxWorkspaceRecoveryOperationRecord,
    input: RecoverSandboxWorkspaceInput,
    sandbox: Sandbox,
  ): SandboxWorkspaceRecoveryResponse {
    if (
      record.ownerRunnerId !== input.ownerRunnerId ||
      record.workspace.volumeId !== input.workspace.volumeId ||
      record.workspace.mountPath !== input.workspace.mountPath ||
      record.workspace.subpath !== input.workspace.subpath
    ) {
      throw new BadRequestException('Workspace recovery operation does not match its original request')
    }
    if (record.status === 'complete') {
      let workspace
      try {
        workspace = buildRunnerVolumes(sandbox).find((volume) => volume.mountPath === '/workspace')
      } catch {
        throw new ConflictException('Recovered sandbox workspace identity is invalid')
      }
      if (
        sandbox.state !== SandboxState.STARTED ||
        sandbox.desiredState !== SandboxDesiredState.STARTED ||
        sandbox.pending ||
        sandbox.runnerId !== input.ownerRunnerId ||
        workspace?.volumeId !== input.workspace.volumeId ||
        workspace?.subpath !== input.workspace.subpath
      ) {
        throw new ConflictException('Recovered sandbox identity changed after operation completion')
      }
      return record.result
    }
    return { outcome: 'operation_in_progress', operationId: record.operationId, sandboxId: record.sandboxId }
  }

  private isExactRecoveredSandbox(sandbox: Sandbox, input: RecoverSandboxWorkspaceInput): boolean {
    let workspace
    try {
      workspace = buildRunnerVolumes(sandbox).find((volume) => volume.mountPath === '/workspace')
    } catch {
      return false
    }
    return (
      sandbox.state === SandboxState.STARTED &&
      sandbox.desiredState === SandboxDesiredState.STARTED &&
      !sandbox.pending &&
      sandbox.runnerId === input.ownerRunnerId &&
      workspace?.volumeId === input.workspace.volumeId &&
      workspace?.subpath === input.workspace.subpath
    )
  }

  private recoveredResult(sandboxId: string, input: RecoverSandboxWorkspaceInput): SandboxWorkspaceRecoveryResult {
    return {
      outcome: 'recovered',
      operationId: input.operationId,
      sandboxId,
      externalId: sandboxId,
      ownerRunnerId: input.ownerRunnerId,
      status: 'running',
      workspace: input.workspace,
    }
  }

  private validateRecoveryJob(
    job: Job,
    jobId: string,
    sandboxId: string,
    input: RecoverSandboxWorkspaceInput,
    originalWorkspace: LocalVolumeMount & { subpath: string },
    createPayload: CreateSandboxDTO,
  ): void {
    const payload = job.getPayload
      ? job.getPayload<{
          operationId: string
          ownerRunnerId: string
          originalVolumeId: string
          originalVolumeSubpath: string
          sandbox: CreateSandboxDTO
        }>()
      : JSON.parse(job.payload ?? 'null')
    const payloadWorkspace = payload?.sandbox?.volumes?.find((volume) => volume.mountPath === '/workspace')
    if (
      job.id !== jobId ||
      job.type !== JobType.RECOVER_SANDBOX_WORKSPACE ||
      job.runnerId !== input.ownerRunnerId ||
      job.resourceType !== ResourceType.SANDBOX ||
      job.resourceId !== sandboxId ||
      payload?.operationId !== input.operationId ||
      payload?.ownerRunnerId !== input.ownerRunnerId ||
      payload?.originalVolumeId !== originalWorkspace.volumeId ||
      payload?.originalVolumeSubpath !== originalWorkspace.subpath ||
      payload?.sandbox?.id !== sandboxId ||
      payload?.sandbox?.snapshot !== createPayload.snapshot ||
      payloadWorkspace?.volumeId !== input.workspace.volumeId ||
      payloadWorkspace?.subpath !== input.workspace.subpath
    ) {
      throw new ConflictException('Runner job conflicts with workspace recovery operation')
    }
  }

  private async waitForJob(initial: Job, input: RecoverSandboxWorkspaceInput): Promise<Job> {
    for (let attempt = 0; attempt < JOB_POLL_ATTEMPTS; attempt += 1) {
      const job = attempt === 0 ? initial : await this.jobService.findOne(initial.id)
      if (
        !job ||
        job.id !== initial.id ||
        job.type !== JobType.RECOVER_SANDBOX_WORKSPACE ||
        job.runnerId !== input.ownerRunnerId ||
        job.resourceType !== ResourceType.SANDBOX ||
        job.resourceId !== initial.resourceId
      ) {
        throw new ConflictException('Runner job identity changed during workspace recovery')
      }
      if (job.status === JobStatus.COMPLETED) return job
      if (job.status === JobStatus.FAILED) throw new ConflictException('Runner rejected exact workspace recovery')
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_INTERVAL_MS))
    }
    throw new ServiceUnavailableException('Timed out waiting for exact workspace recovery')
  }

  private validateJobEvidence(job: Job, sandboxId: string, input: RecoverSandboxWorkspaceInput): string {
    const evidence = job.getResultMetadata ? job.getResultMetadata() : JSON.parse(job.resultMetadata ?? 'null')
    if (
      !evidence ||
      evidence.operationId !== input.operationId ||
      evidence.sandboxId !== sandboxId ||
      evidence.ownerRunnerId !== input.ownerRunnerId ||
      evidence.status !== 'running' ||
      typeof evidence.daemonVersion !== 'string' ||
      evidence.daemonVersion.length === 0 ||
      evidence.daemonVersion.length > 128
    ) {
      throw new ConflictException('Runner returned conflicting workspace recovery evidence')
    }
    return evidence.daemonVersion
  }
}
