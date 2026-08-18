/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Module } from '@nestjs/common'
import { DataSource } from 'typeorm'
import { SandboxController } from './controllers/sandbox.controller'
import { SandboxService } from './services/sandbox.service'
import { TypeOrmModule } from '@nestjs/typeorm'
import { Sandbox } from './entities/sandbox.entity'
import { UserModule } from '../user/user.module'
import { RunnerService } from './services/runner.service'
import { Runner } from './entities/runner.entity'
import { RunnerController } from './controllers/runner.controller'
import { ToolboxService } from './services/toolbox.deprecated.service'
import { DockerRegistryModule } from '../docker-registry/docker-registry.module'
import { SandboxManager } from './managers/sandbox.manager'
import { ToolboxController } from './controllers/toolbox.deprecated.controller'
import { Snapshot } from './entities/snapshot.entity'
import { SnapshotController } from './controllers/snapshot.controller'
import { SnapshotService } from './services/snapshot.service'
import { SnapshotManager } from './managers/snapshot.manager'
import { SnapshotRunner } from './entities/snapshot-runner.entity'
import { DockerRegistry } from '../docker-registry/entities/docker-registry.entity'
import { RedisLockProvider } from './common/redis-lock.provider'
import { OrganizationModule } from '../organization/organization.module'
import { SandboxWarmPoolService } from './services/sandbox-warm-pool.service'
import { WarmPool } from './entities/warm-pool.entity'
import { PreviewController } from './controllers/preview.controller'
import { SnapshotRepository } from './repositories/snapshot.repository'
import { VolumeController } from './controllers/volume.controller'
import { VolumeService } from './services/volume.service'
import { VolumeManager } from './managers/volume.manager'
import { Volume } from './entities/volume.entity'
import { BuildInfo } from './entities/build-info.entity'
import { BackupManager } from './managers/backup.manager'
import { VolumeSubscriber } from './subscribers/volume.subscriber'
import { RunnerSubscriber } from './subscribers/runner.subscriber'
import { RunnerAdapterFactory } from './runner-adapter/runnerAdapter'
import { SandboxStartAction } from './managers/sandbox-actions/sandbox-start.action'
import { SandboxStopAction } from './managers/sandbox-actions/sandbox-stop.action'
import { SandboxDestroyAction } from './managers/sandbox-actions/sandbox-destroy.action'
import { SandboxArchiveAction } from './managers/sandbox-actions/sandbox-archive.action'
import { SshAccess } from './entities/ssh-access.entity'
import { SandboxRepository } from './repositories/sandbox.repository'
import { ProxyCacheInvalidationService } from './services/proxy-cache-invalidation.service'
import { RegionModule } from '../region/region.module'
import { Region } from '../region/entities/region.entity'
import { SnapshotRegion } from './entities/snapshot-region.entity'
import { SandboxFork } from './entities/sandbox-fork.entity'
import { JobController } from './controllers/job.controller'
import { JobService } from './services/job.service'
import { JobStateHandlerService } from './services/job-state-handler.service'
import { Job } from './entities/job.entity'
import { SandboxLookupCacheInvalidationService } from './services/sandbox-lookup-cache-invalidation.service'
import { ProxyAuthContextGuard } from './guards/proxy-auth-context.guard'
import { SshGatewayAuthContextGuard } from './guards/ssh-gateway-auth-context.guard'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { SandboxLastActivity } from './entities/sandbox-last-activity.entity'
import { SandboxActivityService } from './services/sandbox-activity.service'
import { OpensearchModule } from 'nestjs-opensearch'
import { TypedConfigService } from '../config/typed-config.service'
import { SandboxSearchAdapterProvider } from './providers/sandbox-search.provider'
import { StorageNode } from './entities/storage-node.entity'
import { WorkspacePlacement } from './entities/workspace-placement.entity'
import { StorageNodeService } from './services/storage-node.service'
import { WorkspacePlacementService } from './services/workspace-placement.service'
import { StorageNodeRunnerController } from './controllers/storage-node-runner.controller'
import { StorageNodeController } from './controllers/storage-node.controller'
import { WorkspaceGeneration } from './entities/workspace-generation.entity'
import { WorkspaceOperation } from './entities/workspace-operation.entity'
import { WorkspaceGenerationService } from './services/workspace-generation.service'
import { S3Client } from '@aws-sdk/client-s3'
import {
  RunnerStorageAgentCheckpointSource,
  RunnerStorageAgentClient,
  RunnerStorageAgentMoveRuntime,
} from './local-first/runner-storage-agent'
import {
  LOCAL_FIRST_GENERATION_BATCH_SIZE,
  LOCAL_FIRST_GENERATION_PREFIX,
  LOCAL_FIRST_GENERATION_RECONCILER,
  LOCAL_FIRST_GENERATION_SOURCE,
  LOCAL_FIRST_GENERATION_STORE,
} from './local-first/workspace-generation.tokens'
import { S3GenerationObjectStore } from './services/workspace-generation.service'
import {
  WorkspaceGenerationReconciler,
  WorkspaceGenerationWorker,
} from './services/workspace-generation-worker.service'
import { WorkspaceMoveService } from './services/workspace-move.service'
import { WorkspaceMoveTargetPreparationService } from './services/workspace-move-target-preparation.service'
import { WorkspaceMoveReconciler, WorkspaceMoveWorker } from './services/workspace-move-worker.service'
import { WorkspaceDrainService } from './services/workspace-drain.service'
import { WorkspaceDrainWorker } from './services/workspace-drain-worker.service'
import { WorkspaceMoveController } from './controllers/workspace-move.controller'
import { LOCAL_FIRST_MOVE_RECONCILER, LOCAL_FIRST_MOVE_RUNTIME } from './local-first/workspace-move.tokens'

@Module({
  imports: [
    UserModule,
    DockerRegistryModule,
    OrganizationModule,
    RegionModule,
    TypeOrmModule.forFeature([
      Sandbox,
      Runner,
      Snapshot,
      BuildInfo,
      SnapshotRunner,
      SnapshotRegion,
      DockerRegistry,
      WarmPool,
      Volume,
      SshAccess,
      Region,
      Job,
      SandboxLastActivity,
      SandboxFork,
      StorageNode,
      WorkspacePlacement,
      WorkspaceGeneration,
      WorkspaceOperation,
    ]),
    OpensearchModule.forRootAsync({
      inject: [TypedConfigService],
      useFactory: (configService: TypedConfigService) => {
        return configService.getOpenSearchConfig()
      },
    }),
  ],
  controllers: [
    SandboxController,
    RunnerController,
    ToolboxController,
    SnapshotController,
    PreviewController,
    VolumeController,
    JobController,
    StorageNodeRunnerController,
    StorageNodeController,
    WorkspaceMoveController,
  ],
  providers: [
    SandboxService,
    SandboxManager,
    BackupManager,
    SandboxWarmPoolService,
    RunnerService,
    ToolboxService,
    SnapshotService,
    ProxyCacheInvalidationService,
    SandboxLookupCacheInvalidationService,
    SnapshotManager,
    RedisLockProvider,
    VolumeService,
    VolumeManager,
    VolumeSubscriber,
    RunnerSubscriber,
    RunnerAdapterFactory,
    SandboxStartAction,
    SandboxStopAction,
    SandboxDestroyAction,
    SandboxArchiveAction,
    JobService,
    JobStateHandlerService,
    SandboxActivityService,
    StorageNodeService,
    WorkspacePlacementService,
    WorkspaceGenerationService,
    WorkspaceGenerationReconciler,
    WorkspaceGenerationWorker,
    WorkspaceMoveService,
    WorkspaceMoveTargetPreparationService,
    WorkspaceMoveReconciler,
    WorkspaceMoveWorker,
    WorkspaceDrainService,
    WorkspaceDrainWorker,
    RunnerStorageAgentClient,
    ProxyAuthContextGuard,
    SshGatewayAuthContextGuard,
    SandboxSearchAdapterProvider,
    {
      provide: SandboxRepository,
      inject: [DataSource, EventEmitter2, SandboxLookupCacheInvalidationService],
      useFactory: (
        dataSource: DataSource,
        eventEmitter: EventEmitter2,
        sandboxLookupCacheInvalidationService: SandboxLookupCacheInvalidationService,
      ) => new SandboxRepository(dataSource, eventEmitter, sandboxLookupCacheInvalidationService),
    },
    {
      provide: SnapshotRepository,
      inject: [DataSource, EventEmitter2],
      useFactory: (dataSource: DataSource, eventEmitter: EventEmitter2) =>
        new SnapshotRepository(dataSource, eventEmitter),
    },
    {
      provide: LOCAL_FIRST_GENERATION_PREFIX,
      inject: [TypedConfigService],
      useFactory: (configService: TypedConfigService) => configService.get('localFirstGeneration.prefix'),
    },
    {
      provide: LOCAL_FIRST_GENERATION_BATCH_SIZE,
      inject: [TypedConfigService],
      useFactory: (configService: TypedConfigService) => configService.get('localFirstGeneration.batchSize'),
    },
    {
      provide: LOCAL_FIRST_GENERATION_SOURCE,
      inject: [TypedConfigService, RunnerStorageAgentClient],
      useFactory: (configService: TypedConfigService, client: RunnerStorageAgentClient) => {
        if (!configService.get('localFirstGeneration.enabled')) return undefined
        return new RunnerStorageAgentCheckpointSource(client)
      },
    },
    {
      provide: LOCAL_FIRST_GENERATION_STORE,
      inject: [TypedConfigService],
      useFactory: (configService: TypedConfigService) => {
        if (!configService.get('localFirstGeneration.enabled')) return undefined
        const endpoint = configService.getOrThrow('s3.endpoint')
        const region = configService.getOrThrow('s3.region')
        const bucket = configService.getOrThrow('s3.defaultBucket')
        const accessKey = configService.getOrThrow('s3.accessKey')
        const secretKey = configService.getOrThrow('s3.secretKey')
        return new S3GenerationObjectStore(
          new S3Client({
            endpoint,
            region,
            forcePathStyle: configService.get('s3.forcePathStyle'),
            credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
          }),
          bucket,
          configService.get('localFirstGeneration.prefix'),
        )
      },
    },
    {
      provide: LOCAL_FIRST_GENERATION_RECONCILER,
      useExisting: WorkspaceGenerationReconciler,
    },
    {
      provide: LOCAL_FIRST_MOVE_RUNTIME,
      inject: [
        TypedConfigService,
        RunnerStorageAgentClient,
        WorkspacePlacementService,
        WorkspaceMoveTargetPreparationService,
      ],
      useFactory: (
        configService: TypedConfigService,
        client: RunnerStorageAgentClient,
        workspacePlacementService: WorkspacePlacementService,
        targetPreparation: WorkspaceMoveTargetPreparationService,
      ) => {
        if (!configService.get('localFirstGeneration.enabled')) return undefined
        return new RunnerStorageAgentMoveRuntime(client, workspacePlacementService, targetPreparation)
      },
    },
    {
      provide: LOCAL_FIRST_MOVE_RECONCILER,
      useExisting: WorkspaceMoveReconciler,
    },
  ],
  exports: [
    SandboxService,
    RunnerService,
    RedisLockProvider,
    SnapshotService,
    VolumeService,
    VolumeManager,
    SandboxRepository,
    SnapshotRepository,
    RunnerAdapterFactory,
    SandboxActivityService,
    ProxyAuthContextGuard,
    SshGatewayAuthContextGuard,
    StorageNodeService,
    WorkspacePlacementService,
    WorkspaceGenerationService,
    WorkspaceMoveService,
  ],
})
export class SandboxModule {}
