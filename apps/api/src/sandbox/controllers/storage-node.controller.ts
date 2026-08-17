/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOAuth2,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger'
import { AuthStrategy } from '../../auth/decorators/auth-strategy.decorator'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { OrganizationAuthContextGuard } from '../../organization/guards/organization-auth-context.guard'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { RunnerAccessGuard } from '../guards/runner-access.guard'
import { StorageNodeState } from '../enums/storage-node-state.enum'
import { StorageNodeDto } from '../dto/storage-node.dto'
import { StorageNodeService } from '../services/storage-node.service'

@Controller('runners/:runnerId/storage-nodes')
@ApiTags('storage-nodes')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@AuthStrategy([AuthStrategyType.API_KEY, AuthStrategyType.JWT])
@UseGuards(AuthenticatedRateLimitGuard, OrganizationAuthContextGuard, RunnerAccessGuard)
export class StorageNodeController {
  constructor(private readonly storageNodeService: StorageNodeService) {}

  @Get(':nodeId')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_RUNNERS])
  @ApiOperation({
    summary: 'Get storage node status',
    operationId: 'getStorageNodeStatus',
  })
  @ApiParam({ name: 'runnerId', description: 'Runner resource that owns the node', format: 'uuid' })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async getStatus(
    @Param('runnerId', ParseUUIDPipe) runnerId: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<StorageNodeDto> {
    const node = await this.storageNodeService.findOneForRunnerOrFail(nodeId, runnerId)
    return StorageNodeDto.fromStorageNode(node)
  }

  @Post(':nodeId/activate')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_RUNNERS])
  @ApiOperation({ summary: 'Activate a storage node', operationId: 'activateStorageNode' })
  @ApiParam({ name: 'runnerId', description: 'Runner resource that owns the node', format: 'uuid' })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async activate(
    @Param('runnerId', ParseUUIDPipe) runnerId: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<StorageNodeDto> {
    return this.transition(nodeId, runnerId, StorageNodeState.ACTIVE)
  }

  @Post(':nodeId/cordon')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_RUNNERS])
  @ApiOperation({ summary: 'Cordon a storage node', operationId: 'cordonStorageNode' })
  @ApiParam({ name: 'runnerId', description: 'Runner resource that owns the node', format: 'uuid' })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async cordon(
    @Param('runnerId', ParseUUIDPipe) runnerId: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<StorageNodeDto> {
    return this.transition(nodeId, runnerId, StorageNodeState.CORDONED)
  }

  @Post(':nodeId/drain')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_RUNNERS])
  @ApiOperation({ summary: 'Start draining a storage node', operationId: 'drainStorageNode' })
  @ApiParam({ name: 'runnerId', description: 'Runner resource that owns the node', format: 'uuid' })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async drain(
    @Param('runnerId', ParseUUIDPipe) runnerId: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<StorageNodeDto> {
    return this.transition(nodeId, runnerId, StorageNodeState.DRAINING)
  }

  @Post(':nodeId/remove')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_RUNNERS])
  @ApiOperation({ summary: 'Tombstone a drained storage node', operationId: 'removeStorageNode' })
  @ApiParam({ name: 'runnerId', description: 'Runner resource that owns the node', format: 'uuid' })
  @ApiParam({ name: 'nodeId', description: 'Stable storage node identifier', format: 'uuid' })
  @ApiResponse({ status: 200, type: StorageNodeDto })
  async remove(
    @Param('runnerId', ParseUUIDPipe) runnerId: string,
    @Param('nodeId', ParseUUIDPipe) nodeId: string,
  ): Promise<StorageNodeDto> {
    return this.transition(nodeId, runnerId, StorageNodeState.REMOVED)
  }

  private async transition(nodeId: string, runnerId: string, nextState: StorageNodeState): Promise<StorageNodeDto> {
    const node = await this.storageNodeService.transition(nodeId, nextState, runnerId)
    return StorageNodeDto.fromStorageNode(node)
  }
}
