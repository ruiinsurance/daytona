/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable, Logger } from '@nestjs/common'
import { create, toJson } from '@bufbuild/protobuf'
import {
  SnapshotSandboxPayloadSchema,
  ForkSandboxPayloadSchema,
  PauseSandboxPayloadSchema,
  RegistrySchema,
} from '@daytona/runner-proto'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository, IsNull, Not } from 'typeorm'
import {
  RunnerAdapter,
  RunnerInfo,
  RunnerSandboxInfo,
  RunnerSnapshotInfo,
  StartSandboxResponse,
  SnapshotDigestResponse,
} from './runnerAdapter'
import { Runner } from '../entities/runner.entity'
import { Sandbox } from '../entities/sandbox.entity'
import { Job } from '../entities/job.entity'
import { BuildInfo } from '../entities/build-info.entity'
import { DockerRegistry } from '../../docker-registry/entities/docker-registry.entity'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxClass } from '../enums/sandbox-class.enum'
import { JobType } from '../enums/job-type.enum'
import { JobStatus } from '../enums/job-status.enum'
import { ResourceType } from '../enums/resource-type.enum'
import { JobService } from '../services/job.service'
import { SandboxRepository } from '../repositories/sandbox.repository'
import {
  CreateSandboxDTO,
  CreateBackupDTO,
  BuildSnapshotRequestDTO,
  PullSnapshotRequestDTO,
  UpdateNetworkSettingsDTO,
  InspectSnapshotInRegistryRequest,
  RecoverSandboxDTO,
} from '@daytona/runner-api-client'
import { SnapshotStateError } from '../errors/snapshot-state-error'
import { LOCAL_FIRST_STORAGE_BACKEND } from '../local-first/storage-node-contract'
import {
  buildPreparedLocalFirstVolumes,
  type LocalFirstWorkspacePreparation,
} from '../local-first/runner-volume.contract'
import { StorageNodeService } from '../services/storage-node.service'
import { WorkspacePlacementService } from '../services/workspace-placement.service'

/**
 * RunnerAdapterV2 implements RunnerAdapter for v2 runners.
 * Instead of making direct API calls to the runner, it creates jobs in the database
 * that the v2 runner polls and processes asynchronously.
 */
@Injectable()
export class RunnerAdapterV2 implements RunnerAdapter {
  private readonly logger = new Logger(RunnerAdapterV2.name)
  protected runner: Runner

  constructor(
    protected readonly sandboxRepository: SandboxRepository,
    @InjectRepository(Job)
    protected readonly jobRepository: Repository<Job>,
    protected readonly jobService: JobService,
    protected readonly storageNodeService: StorageNodeService,
    protected readonly workspacePlacementService: WorkspacePlacementService,
  ) {}

  async init(runner: Runner): Promise<void> {
    this.runner = runner
  }

  async healthCheck(_signal?: AbortSignal): Promise<void> {
    throw new Error('healthCheck is not supported for V2 runners')
  }

  async runnerInfo(_signal?: AbortSignal): Promise<RunnerInfo> {
    throw new Error('runnerInfo is not supported for V2 runners')
  }

  async sandboxInfo(sandboxId: string): Promise<RunnerSandboxInfo> {
    // Query the sandbox entity
    const sandbox = await this.sandboxRepository.findOne({
      where: { id: sandboxId },
    })

    if (!sandbox) {
      throw new Error(`Sandbox ${sandboxId} not found`)
    }

    // Query for any incomplete jobs for this sandbox to determine transitional state
    const incompleteJob = await this.jobRepository.findOne({
      where: {
        resourceType: ResourceType.SANDBOX,
        resourceId: sandboxId,
        completedAt: IsNull(),
      },
      order: { createdAt: 'DESC' },
    })

    let state = sandbox.state

    let daemonVersion: string | undefined = undefined

    // If there's an incomplete job, infer the transitional state from job type
    if (incompleteJob) {
      state = this.inferStateFromJob(incompleteJob, sandbox)
      daemonVersion = incompleteJob.getResultMetadata()?.daemonVersion
    } else {
      // Look for latest job for this sandbox
      const latestJob = await this.jobRepository.findOne({
        where: {
          resourceType: ResourceType.SANDBOX,
          resourceId: sandboxId,
        },
        order: { createdAt: 'DESC' },
      })
      if (latestJob) {
        state = this.inferStateFromJob(latestJob, sandbox)
        daemonVersion = latestJob.getResultMetadata()?.daemonVersion
      }
    }

    return {
      state,
      backupState: sandbox.backupState,
      backupErrorReason: sandbox.backupErrorReason,
      recoverable: sandbox.recoverable,
      daemonVersion,
    }
  }

  private inferStateFromJob(job: Job, sandbox: Sandbox): SandboxState {
    // Map job types to transitional states
    switch (job.type) {
      case JobType.CREATE_SANDBOX:
        if (job.getPayload<{ moveTargetPreparation?: boolean }>()?.moveTargetPreparation === true) {
          return sandbox.state
        }
        if (job.status === JobStatus.COMPLETED) {
          return SandboxState.STARTED
        }
        if (sandbox.state === SandboxState.RESTORING) {
          return SandboxState.RESTORING
        }
        return SandboxState.CREATING
      case JobType.START_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.STARTED : SandboxState.STARTING
      case JobType.STOP_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.STOPPED : SandboxState.STOPPING
      case JobType.DESTROY_SANDBOX:
        return job.status === JobStatus.COMPLETED ? SandboxState.DESTROYED : SandboxState.DESTROYING
      default:
        // For other job types (backup, etc.), return current sandbox state
        return sandbox.state
    }
  }

  async createSandbox(
    sandbox: Sandbox,
    snapshotRef: string,
    registry?: DockerRegistry,
    entrypoint?: string[],
    metadata?: { [key: string]: string },
    otelEndpoint?: string,
    skipStart?: boolean,
  ): Promise<StartSandboxResponse | undefined> {
    const payload = await this.buildCreateSandboxPayload(
      sandbox,
      snapshotRef,
      registry,
      entrypoint,
      metadata,
      otelEndpoint,
      skipStart,
    )

    await this.jobService.createJob(
      null,
      JobType.CREATE_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      sandbox.id,
      payload,
    )

    this.logger.debug(`Created CREATE_SANDBOX job for sandbox ${sandbox.id} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  async prepareSandbox(
    sandbox: Sandbox,
    snapshotRef: string,
    registry: DockerRegistry | undefined,
    entrypoint: string[] | undefined,
    metadata: { [key: string]: string } | undefined,
    otelEndpoint: string | undefined,
    preparation: LocalFirstWorkspacePreparation,
  ): Promise<void> {
    const payload = await this.buildCreateSandboxPayload(
      sandbox,
      snapshotRef,
      registry,
      entrypoint,
      metadata,
      otelEndpoint,
      true,
      preparation,
    )
    const job = await this.jobService.createJob(
      null,
      JobType.CREATE_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      sandbox.id,
      { ...payload, moveTargetPreparation: true },
    )
    await this.waitForTargetPreparation(job.id)
  }

  async startSandbox(
    sandboxId: string,
    authToken: string,
    metadata?: { [key: string]: string },
  ): Promise<StartSandboxResponse | undefined> {
    let effectiveMetadata = metadata
    if (metadata?.storageBackend === LOCAL_FIRST_STORAGE_BACKEND) {
      const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
      if (!sandbox) throw new Error('Sandbox not found for local-first start')
      const volumes = await this.buildRunnerVolumes(sandbox, true)
      effectiveMetadata = {
        ...metadata,
        volumes: JSON.stringify(volumes),
      }
    } else {
      const placement = await this.workspacePlacementService.findBySandboxId(sandboxId)
      if (placement) {
        const sandbox = await this.sandboxRepository.findOne({ where: { id: sandboxId } })
        if (!sandbox) throw new Error('Sandbox not found for local-first placement')
        const volumes = await this.buildRunnerVolumes(sandbox, true)
        effectiveMetadata = {
          ...metadata,
          storageBackend: LOCAL_FIRST_STORAGE_BACKEND,
          volumes: JSON.stringify(volumes),
        }
      }
    }
    await this.jobService.createJob(null, JobType.START_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId, {
      authToken,
      metadata: effectiveMetadata,
    })

    this.logger.debug(`Created START_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)

    // Daemon version will be set in the job result metadata
    return undefined
  }

  private async buildCreateSandboxPayload(
    sandbox: Sandbox,
    snapshotRef: string,
    registry: DockerRegistry | undefined,
    entrypoint: string[] | undefined,
    metadata: { [key: string]: string } | undefined,
    otelEndpoint: string | undefined,
    skipStart?: boolean,
    preparation?: LocalFirstWorkspacePreparation,
  ): Promise<CreateSandboxDTO> {
    const localFirstRequested =
      Boolean(preparation) ||
      metadata?.storageBackend === LOCAL_FIRST_STORAGE_BACKEND ||
      sandbox.volumes?.some((volume) => volume.backend === LOCAL_FIRST_STORAGE_BACKEND)
    const volumes = await this.buildRunnerVolumes(sandbox, localFirstRequested, preparation)
    return {
      id: sandbox.id,
      name: sandbox.name,
      userId: sandbox.organizationId,
      snapshot: snapshotRef,
      osUser: sandbox.osUser,
      cpuQuota: sandbox.cpu,
      gpuQuota: sandbox.gpu,
      memoryQuota: sandbox.mem,
      storageQuota: sandbox.disk,
      env: sandbox.env,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
      entrypoint,
      volumes,
      networkBlockAll: sandbox.networkBlockAll,
      networkAllowList: sandbox.networkAllowList,
      domainAllowList: sandbox.domainAllowList,
      metadata,
      authToken: sandbox.authToken,
      otelEndpoint,
      skipStart,
      organizationId: sandbox.organizationId,
      regionId: sandbox.region,
      linkedSandboxId: sandbox.linkedSandboxId ?? undefined,
      sandboxClass: sandbox.sandboxClass,
    }
  }

  private async buildRunnerVolumes(
    sandbox: Sandbox,
    localFirst: boolean,
    preparation?: LocalFirstWorkspacePreparation,
  ): Promise<Array<Record<string, string>>> {
    const volumes =
      sandbox.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        ...(volume.subpath ? { subpath: volume.subpath } : {}),
      })) ?? []
    if (!localFirst) return volumes

    if (preparation) return buildPreparedLocalFirstVolumes(sandbox, preparation)

    const workspace = sandbox.volumes?.find((volume) => volume.mountPath === '/workspace')
    const config = sandbox.volumes?.find((volume) => volume.mountPath === '/config')
    if (
      !workspace ||
      !config ||
      workspace.volumeId !== config.volumeId ||
      workspace.subpath !== config.subpath ||
      workspace.subpath !== `sandboxes/${sandbox.id}/workspace`
    ) {
      throw new Error('local-first workspace requires matching /workspace and /config identity')
    }

    const storageNode = await this.storageNodeService.findByRunnerId(this.runner.id)
    if (!storageNode) throw new Error('local-first storage node is not registered')
    const existingPlacement = await this.workspacePlacementService.findBySandboxId(sandbox.id)
    if (existingPlacement) {
      await this.workspacePlacementService.assertStartAllowed({
        placement: existingPlacement,
        nodeId: storageNode.nodeId,
      })
    }
    const placement = await this.workspacePlacementService.ensurePlacement({
      volumeId: workspace.volumeId,
      subpath: workspace.subpath,
      sandboxId: sandbox.id,
      requiredBytes: Math.max(0, sandbox.disk) * 1024 * 1024 * 1024,
      requiredInodes: 1,
      ownerNodeId: storageNode.nodeId,
    })
    if (!existingPlacement) {
      await this.workspacePlacementService.assertStartAllowed({
        placement,
        nodeId: storageNode.nodeId,
      })
    }
    const fenceEpoch = Number(placement.fenceEpoch)
    if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch <= 0 || placement.ownerNodeId !== storageNode.nodeId) {
      throw new Error('local-first placement fence is invalid')
    }
    const leaseOwner = `runner:${this.runner.id}:sandbox:${sandbox.id}`
    const leased = await this.workspacePlacementService.acquireWriterLease({
      placementId: placement.id,
      nodeId: storageNode.nodeId,
      fenceEpoch,
      leaseOwner,
    })
    if (!leased.leaseExpiresAt) throw new Error('local-first writer lease has no expiry')
    const leaseExpiresAt =
      leased.leaseExpiresAt instanceof Date ? leased.leaseExpiresAt : new Date(leased.leaseExpiresAt)
    if (!Number.isFinite(leaseExpiresAt.getTime())) throw new Error('local-first writer lease expiry is invalid')

    return volumes.map((volume) => {
      if (volume.mountPath !== '/workspace' && volume.mountPath !== '/config') return volume
      return {
        ...volume,
        backend: LOCAL_FIRST_STORAGE_BACKEND,
        nodeId: storageNode.nodeId,
        fenceEpoch: String(leased.fenceEpoch),
        leaseOwner,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      }
    })
  }

  private async waitForTargetPreparation(jobId: string): Promise<void> {
    const deadline = Date.now() + 4 * 60 * 1000
    while (Date.now() < deadline) {
      const job = await this.jobService.findOne(jobId)
      if (!job) throw new Error('storage_agent_target_preparation_failed')
      if (job.status === JobStatus.COMPLETED) return
      if (job.status === JobStatus.FAILED) throw new Error('storage_agent_target_preparation_failed')
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error('storage_agent_target_preparation_timeout')
  }

  async stopSandbox(sandboxId: string, force?: boolean): Promise<void> {
    await this.jobService.createJob(null, JobType.STOP_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId, {
      force,
    })

    this.logger.debug(`Created STOP_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    await this.jobService.createJob(null, JobType.DESTROY_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId)

    this.logger.debug(`Created DESTROY_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }

  async recoverSandbox(sandbox: Sandbox, registry?: DockerRegistry, skipStart = false): Promise<void> {
    const recoverSandboxDTO: RecoverSandboxDTO = {
      userId: sandbox.organizationId,
      snapshot: sandbox.snapshot,
      osUser: sandbox.osUser,
      cpuQuota: sandbox.cpu,
      gpuQuota: sandbox.gpu,
      memoryQuota: sandbox.mem,
      storageQuota: sandbox.disk,
      env: sandbox.env,
      volumes: sandbox.volumes?.map((volume) => ({
        volumeId: volume.volumeId,
        mountPath: volume.mountPath,
        subpath: volume.subpath,
      })),
      networkBlockAll: sandbox.networkBlockAll,
      networkAllowList: sandbox.networkAllowList,
      errorReason: sandbox.errorReason,
      backupErrorReason: sandbox.backupErrorReason,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    }
    // skipStart is API-side metadata for the job-completion handler; the runner ignores extra fields.
    await this.jobService.createJob(null, JobType.RECOVER_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandbox.id, {
      ...recoverSandboxDTO,
      skipStart,
    })

    this.logger.debug(`Created RECOVER_SANDBOX job for sandbox ${sandbox.id} on runner ${this.runner.id}`)
  }

  async createBackup(sandbox: Sandbox, backupSnapshotName: string, registry?: DockerRegistry): Promise<void> {
    const payload: CreateBackupDTO = {
      snapshot: backupSnapshotName,
      registry: undefined,
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    await this.jobService.createJob(
      null,
      JobType.CREATE_BACKUP,
      this.runner.id,
      ResourceType.SANDBOX,
      sandbox.id,
      payload,
    )

    this.logger.debug(`Created CREATE_BACKUP job for sandbox ${sandbox.id} on runner ${this.runner.id}`)
  }

  async buildSnapshot(
    buildInfo: BuildInfo,
    organizationId?: string,
    sourceRegistries?: DockerRegistry[],
    registry?: DockerRegistry,
    pushToInternalRegistry?: boolean,
  ): Promise<void> {
    const payload: BuildSnapshotRequestDTO = {
      snapshot: buildInfo.snapshotRef,
      dockerfile: buildInfo.dockerfileContent,
      organizationId: organizationId,
      context: buildInfo.contextHashes,
      pushToInternalRegistry: pushToInternalRegistry,
    }

    if (sourceRegistries) {
      payload.sourceRegistries = sourceRegistries.map((sourceRegistry) => ({
        project: sourceRegistry.project,
        url: sourceRegistry.url.replace(/^(https?:\/\/)/, ''),
        username: sourceRegistry.username,
        password: sourceRegistry.password,
      }))
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    await this.jobService.createJob(
      null,
      JobType.BUILD_SNAPSHOT,
      this.runner.id,
      ResourceType.SNAPSHOT,
      buildInfo.snapshotRef,
      payload,
    )

    this.logger.debug(`Created BUILD_SNAPSHOT job for ${buildInfo.snapshotRef} on runner ${this.runner.id}`)
  }

  async pullSnapshot(
    snapshotName: string,
    registry?: DockerRegistry,
    destinationRegistry?: DockerRegistry,
    destinationRef?: string,
    newTag?: string,
    sandboxClass?: SandboxClass,
  ): Promise<void> {
    const payload: PullSnapshotRequestDTO = {
      snapshot: snapshotName,
      newTag,
      sandboxClass,
    }

    if (registry) {
      payload.registry = {
        project: registry.project,
        url: registry.url.replace(/^(https?:\/\/)/, ''),
        username: registry.username,
        password: registry.password,
      }
    }

    if (destinationRegistry) {
      payload.destinationRegistry = {
        project: destinationRegistry.project,
        url: destinationRegistry.url.replace(/^(https?:\/\/)/, ''),
        username: destinationRegistry.username,
        password: destinationRegistry.password,
      }
    }

    if (destinationRef) {
      payload.destinationRef = destinationRef
    }

    await this.jobService.createJob(
      null,
      JobType.PULL_SNAPSHOT,
      this.runner.id,
      ResourceType.SNAPSHOT,
      destinationRef || snapshotName,
      payload,
    )

    this.logger.debug(`Created PULL_SNAPSHOT job for ${snapshotName} on runner ${this.runner.id}`)
  }

  async removeSnapshot(snapshotName: string): Promise<void> {
    await this.jobService.createJob(null, JobType.REMOVE_SNAPSHOT, this.runner.id, ResourceType.SNAPSHOT, snapshotName)

    this.logger.debug(`Created REMOVE_SNAPSHOT job for ${snapshotName} on runner ${this.runner.id}`)
  }

  async snapshotExists(snapshotRef: string): Promise<boolean> {
    // Find the latest job for this snapshot on this runner
    // Do not include INSPECT_SNAPSHOT_IN_REGISTRY
    const latestJob = await this.jobRepository.findOne({
      where: [
        {
          runnerId: this.runner.id,
          resourceType: ResourceType.SNAPSHOT,
          resourceId: snapshotRef,
          type: Not(JobType.INSPECT_SNAPSHOT_IN_REGISTRY),
        },
      ],
      order: { createdAt: 'DESC' },
    })

    // If no job exists, snapshot doesn't exist
    if (!latestJob) {
      return false
    }

    // If the latest job is a REMOVE_SNAPSHOT, the snapshot no longer exists
    if (latestJob.type === JobType.REMOVE_SNAPSHOT) {
      return false
    }

    // If the latest job is PULL_SNAPSHOT or BUILD_SNAPSHOT, check if it completed successfully
    if (latestJob.type === JobType.PULL_SNAPSHOT || latestJob.type === JobType.BUILD_SNAPSHOT) {
      return latestJob.status === JobStatus.COMPLETED
    }

    // For any other job type, snapshot doesn't exist
    return false
  }

  async getSnapshotInfo(snapshotRef: string): Promise<RunnerSnapshotInfo> {
    const latestJob = await this.jobRepository.findOne({
      where: [
        {
          runnerId: this.runner.id,
          resourceType: ResourceType.SNAPSHOT,
          resourceId: snapshotRef,
          type: Not(JobType.INSPECT_SNAPSHOT_IN_REGISTRY),
        },
      ],
      order: { createdAt: 'DESC' },
    })

    if (!latestJob) {
      throw new Error(`Snapshot ${snapshotRef} not found on runner ${this.runner.id}`)
    }

    const metadata = latestJob.getResultMetadata()

    switch (latestJob.status) {
      case JobStatus.COMPLETED:
        if (latestJob.type === JobType.PULL_SNAPSHOT || latestJob.type === JobType.BUILD_SNAPSHOT) {
          return {
            name: latestJob.resourceId,
            sizeGB: metadata?.sizeGB,
            entrypoint: metadata?.entrypoint,
            cmd: metadata?.cmd,
            hash: metadata?.hash,
          }
        }
        throw new Error(
          `Snapshot ${snapshotRef} is in an unknown state (${latestJob.status}) on runner ${this.runner.id}`,
        )
      case JobStatus.FAILED:
        throw new SnapshotStateError(
          latestJob.errorMessage || `Snapshot ${snapshotRef} failed on runner ${this.runner.id}`,
        )
      default:
        throw new Error(
          `Snapshot ${snapshotRef} is in an unknown state (${latestJob.status}) on runner ${this.runner.id}`,
        )
    }
  }

  async inspectSnapshotInRegistry(snapshotName: string, registry?: DockerRegistry): Promise<SnapshotDigestResponse> {
    const payload: InspectSnapshotInRegistryRequest = {
      snapshot: snapshotName,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    }

    const job = await this.jobService.createJob(
      null,
      JobType.INSPECT_SNAPSHOT_IN_REGISTRY,
      this.runner.id,
      ResourceType.SNAPSHOT,
      snapshotName,
      payload,
    )

    this.logger.debug(`Created INSPECT_SNAPSHOT_IN_REGISTRY job for ${snapshotName} on runner ${this.runner.id}`)

    const waitTimeout = 30 * 1000 // 30 seconds
    const completedJob = await this.jobService.waitJobCompletion(job.id, waitTimeout)

    if (!completedJob) {
      throw new Error(`Snapshot ${snapshotName} not found in registry on runner ${this.runner.id}`)
    }

    if (completedJob.status !== JobStatus.COMPLETED) {
      throw new Error(
        `Snapshot ${snapshotName} failed to inspect in registry on runner ${this.runner.id}. Error: ${completedJob.errorMessage}`,
      )
    }

    const resultMetadata = completedJob.getResultMetadata()

    return {
      hash: resultMetadata?.hash,
      sizeGB: resultMetadata?.sizeGB,
    }
  }

  async updateNetworkSettings(
    sandboxId: string,
    networkBlockAll?: boolean,
    networkAllowList?: string,
    networkLimitEgress?: boolean,
    domainAllowList?: string,
  ): Promise<void> {
    const payload: UpdateNetworkSettingsDTO = {
      networkBlockAll: networkBlockAll,
      networkAllowList: networkAllowList,
      networkLimitEgress: networkLimitEgress,
      domainAllowList: domainAllowList,
    }

    await this.jobService.createJob(
      null,
      JobType.UPDATE_SANDBOX_NETWORK_SETTINGS,
      this.runner.id,
      ResourceType.SANDBOX,
      sandboxId,
      payload,
    )

    this.logger.debug(
      `Created UPDATE_SANDBOX_NETWORK_SETTINGS job for sandbox ${sandboxId} on runner ${this.runner.id}`,
    )
  }

  async pauseSandbox(sandboxId: string): Promise<void> {
    const payload = toJson(
      PauseSandboxPayloadSchema,
      create(PauseSandboxPayloadSchema, {
        sandboxId,
      }),
    ) as Record<string, unknown>

    await this.jobService.createJob(
      null,
      JobType.PAUSE_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      sandboxId,
      payload,
    )

    this.logger.debug(`Created PAUSE_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }

  async forkSandbox(sourceSandboxId: string, newSandboxId: string): Promise<void> {
    const payload = toJson(
      ForkSandboxPayloadSchema,
      create(ForkSandboxPayloadSchema, {
        sourceSandboxId,
        newSandboxId,
      }),
    ) as Record<string, unknown>

    await this.jobService.createJob(
      null,
      JobType.FORK_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      newSandboxId,
      payload,
    )

    this.logger.debug(
      `Created FORK_SANDBOX job for sandbox ${sourceSandboxId} -> ${newSandboxId} on runner ${this.runner.id}`,
    )
  }

  // v2 dispatches snapshot-from-sandbox as an async job; the actual
  // CreateSandboxSnapshotResult arrives via the job state handler when the
  // runner finishes the work, so this method intentionally resolves to
  // `undefined`.
  async createSnapshotFromSandbox(
    sandboxId: string,
    snapshotName: string,
    organizationId: string,
    registry?: DockerRegistry,
    includeMemory?: boolean,
  ): Promise<undefined> {
    const payload = toJson(
      SnapshotSandboxPayloadSchema,
      create(SnapshotSandboxPayloadSchema, {
        sandboxId,
        name: snapshotName,
        organizationId,
        includeMemory: includeMemory ?? false,
        registry: registry
          ? create(RegistrySchema, {
              url: registry.url.replace(/^(https?:\/\/)/, ''),
              username: registry.username ?? undefined,
              password: registry.password ?? undefined,
              project: registry.project ?? undefined,
            })
          : undefined,
      }),
    ) as Record<string, unknown>

    await this.jobService.createJob(
      null,
      JobType.SNAPSHOT_SANDBOX,
      this.runner.id,
      ResourceType.SANDBOX,
      sandboxId,
      payload,
    )

    this.logger.debug(`Created SNAPSHOT_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }

  async resizeSandbox(
    sandboxId: string,
    cpu?: number,
    memory?: number,
    disk?: number,
    registry?: DockerRegistry,
  ): Promise<void> {
    await this.jobService.createJob(null, JobType.RESIZE_SANDBOX, this.runner.id, ResourceType.SANDBOX, sandboxId, {
      cpu,
      memory,
      disk,
      registry: registry
        ? {
            project: registry.project,
            url: registry.url.replace(/^(https?:\/\/)/, ''),
            username: registry.username,
            password: registry.password,
          }
        : undefined,
    })

    this.logger.debug(`Created RESIZE_SANDBOX job for sandbox ${sandboxId} on runner ${this.runner.id}`)
  }
}
