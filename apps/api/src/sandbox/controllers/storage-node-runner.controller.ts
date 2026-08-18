/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuthStrategy } from '../../auth/decorators/auth-strategy.decorator'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { IsRunnerAuthContext } from '../../common/decorators/auth-context.decorator'
import { RunnerAuthContext } from '../../common/interfaces/runner-auth-context.interface'
import { RunnerAuthContextGuard } from '../guards/runner-auth-context.guard'
import {
  HeartbeatStorageNodeDto,
  MarkWorkspaceDirtyDto,
  MarkWorkspaceDirtyResponseDto,
  RegisterStorageNodeDto,
  StorageNodeDto,
} from '../dto/storage-node.dto'
import { StorageNodeService } from '../services/storage-node.service'
import { WorkspaceGenerationService } from '../services/workspace-generation.service'

@Controller('storage-nodes')
@ApiTags('storage-nodes')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@AuthStrategy(AuthStrategyType.API_KEY)
@UseGuards(AuthenticatedRateLimitGuard)
export class StorageNodeRunnerController {
  constructor(
    private readonly storageNodeService: StorageNodeService,
    private readonly workspaceGenerationService: WorkspaceGenerationService,
  ) {}

  @Post('register')
  @HttpCode(200)
  @AuthStrategy(AuthStrategyType.API_KEY)
  @UseGuards(RunnerAuthContextGuard)
  @ApiOperation({
    summary: 'Register the authenticated Runner storage node',
    operationId: 'registerStorageNode',
  })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async register(
    @IsRunnerAuthContext() runnerContext: RunnerAuthContext,
    @Body() input: RegisterStorageNodeDto,
  ): Promise<StorageNodeDto> {
    const node = await this.storageNodeService.register({
      runnerId: runnerContext.runnerId,
      nodeId: input.nodeId,
      capacityBytes: input.capacityBytes,
      capacityInodes: input.capacityInodes,
      labels: input.labels,
    })
    return StorageNodeDto.fromStorageNode(node)
  }

  @Post(':nodeId/heartbeat')
  @HttpCode(200)
  @AuthStrategy(AuthStrategyType.API_KEY)
  @UseGuards(RunnerAuthContextGuard)
  @ApiOperation({
    summary: 'Record storage capacity and heartbeat for the authenticated Runner',
    operationId: 'heartbeatStorageNode',
  })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async heartbeat(
    @IsRunnerAuthContext() runnerContext: RunnerAuthContext,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: HeartbeatStorageNodeDto,
  ): Promise<StorageNodeDto> {
    const node = await this.storageNodeService.heartbeat({
      runnerId: runnerContext.runnerId,
      nodeId,
      capacityBytes: input.capacityBytes,
      usedBytes: input.usedBytes,
      capacityInodes: input.capacityInodes,
      usedInodes: input.usedInodes,
      labels: input.labels,
    })
    return StorageNodeDto.fromStorageNode(node)
  }

  @Post(':nodeId/workspaces/dirty')
  @HttpCode(200)
  @AuthStrategy(AuthStrategyType.API_KEY)
  @UseGuards(RunnerAuthContextGuard)
  @ApiOperation({
    summary: 'Mark an owner-local workspace dirty',
    operationId: 'markStorageWorkspaceDirty',
  })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: MarkWorkspaceDirtyResponseDto })
  async markDirty(
    @IsRunnerAuthContext() runnerContext: RunnerAuthContext,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
    @Body() input: MarkWorkspaceDirtyDto,
  ): Promise<MarkWorkspaceDirtyResponseDto> {
    await this.storageNodeService.findOneForRunnerOrFail(nodeId, runnerContext.runnerId)
    await this.workspaceGenerationService.markDirtyByIdentity({
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      ownerNodeId: nodeId,
      localGeneration: input.localGeneration,
    })
    return { accepted: true }
  }
}
