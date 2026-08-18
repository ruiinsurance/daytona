/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { DockerRegistryService } from '../../docker-registry/services/docker-registry.service'
import { OrganizationService } from '../../organization/services/organization.service'
import { TypedConfigService } from '../../config/typed-config.service'
import { StorageNode } from '../entities/storage-node.entity'
import { RunnerAdapterFactory, type LocalFirstWorkspacePreparation } from '../runner-adapter/runnerAdapter'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { SnapshotService } from './snapshot.service'
import { RunnerService } from './runner.service'
import { isRegistryBasedSandboxClass } from '../utils/sandbox-class.util'
import { LOCAL_FIRST_STORAGE_BACKEND } from '../local-first/storage-node-contract'
import { isStorageAgentErrorCode } from '../local-first/storage-agent-error.contract'

interface TargetPreparationInput {
  sandboxId: string
  nodeId: string
  preparation: LocalFirstWorkspacePreparation
}

@Injectable()
export class WorkspaceMoveTargetPreparationService {
  constructor(
    private readonly sandboxRepository: SandboxRepository,
    @InjectRepository(StorageNode)
    private readonly storageNodeRepository: Repository<StorageNode>,
    private readonly runnerService: RunnerService,
    private readonly runnerAdapterFactory: RunnerAdapterFactory,
    private readonly snapshotService: SnapshotService,
    private readonly dockerRegistryService: DockerRegistryService,
    private readonly organizationService: OrganizationService,
    private readonly configService: TypedConfigService,
  ) {}

  async prepare(input: TargetPreparationInput): Promise<void> {
    try {
      if (input.preparation.nodeId !== input.nodeId) {
        throw new Error('storage_agent_target_preparation_failed')
      }

      const sandbox = await this.sandboxRepository.findOne({
        where: { id: input.sandboxId },
        relations: { buildInfo: true },
      })
      if (!sandbox) throw new Error('storage_agent_target_preparation_failed')

      // The move operation owns the target node. Do not use sandbox.runnerId:
      // it intentionally still points at the source until owner CAS succeeds.
      const storageNode = await this.storageNodeRepository.findOne({ where: { nodeId: input.nodeId } })
      if (!storageNode) throw new Error('storage_agent_runner_unavailable')
      const runner = await this.runnerService.findOneOrFail(storageNode.runnerId)
      const runnerAdapter = await this.runnerAdapterFactory.create(runner)

      const { snapshotRef, entrypoint, registry } = await this.resolveImage(sandbox, runner.region)
      const organization = await this.organizationService.findOne(sandbox.organizationId)
      const metadata = {
        ...organization?.sandboxMetadata,
        sandboxName: sandbox.name,
        storageBackend: LOCAL_FIRST_STORAGE_BACKEND,
      }

      await runnerAdapter.prepareSandbox(
        sandbox,
        snapshotRef,
        registry,
        entrypoint,
        metadata,
        this.configService.get('otelCollector.endpointUrl'),
        input.preparation,
      )
    } catch (error) {
      if (error instanceof Error && isStorageAgentErrorCode(error.message)) throw error
      throw new Error('storage_agent_target_preparation_failed')
    }
  }

  private async resolveImage(
    sandbox: {
      snapshot?: string
      organizationId: string
      buildInfo?: { snapshotRef: string; dockerfileContent?: string }
    },
    runnerRegion: string,
  ): Promise<{
    snapshotRef: string
    entrypoint?: string[]
    registry?: Awaited<ReturnType<DockerRegistryService['findInternalRegistryBySnapshotRef']>>
  }> {
    if (sandbox.buildInfo?.snapshotRef) {
      return {
        snapshotRef: sandbox.buildInfo.snapshotRef,
        entrypoint: this.snapshotService.getEntrypointFromDockerfile(sandbox.buildInfo.dockerfileContent ?? ''),
      }
    }

    if (!sandbox.snapshot) throw new Error('storage_agent_target_preparation_failed')
    const snapshot = await this.snapshotService.getSnapshotByName(sandbox.snapshot, sandbox.organizationId)
    let registry: Awaited<ReturnType<DockerRegistryService['findInternalRegistryBySnapshotRef']>>
    if (isRegistryBasedSandboxClass(snapshot.sandboxClass)) {
      registry = await this.dockerRegistryService.findInternalRegistryBySnapshotRef(snapshot.ref, runnerRegion)
      if (!registry) throw new Error('storage_agent_target_preparation_failed')
    }
    return { snapshotRef: snapshot.ref, entrypoint: snapshot.entrypoint, registry }
  }
}
