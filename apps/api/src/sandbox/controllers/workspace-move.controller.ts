/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, Get, HttpCode, NotFoundException, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger'
import { AuthStrategy } from '../../auth/decorators/auth-strategy.decorator'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { CustomHeaders } from '../../common/constants/header.constants'
import { IsOrganizationAuthContext } from '../../common/decorators/auth-context.decorator'
import { OrganizationAuthContext } from '../../common/interfaces/organization-auth-context.interface'
import { OrganizationAuthContextGuard } from '../../organization/guards/organization-auth-context.guard'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { SandboxRepository } from '../repositories/sandbox.repository'
import { WorkspaceMoveService } from '../services/workspace-move.service'
import { WorkspacePlacementService } from '../services/workspace-placement.service'
import { RequestWorkspaceMoveDto, WorkspaceOperationDto } from '../dto/workspace-operation.dto'

@Controller('storage-workspaces')
@ApiTags('storage-workspaces')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@AuthStrategy([AuthStrategyType.API_KEY, AuthStrategyType.JWT])
@UseGuards(AuthenticatedRateLimitGuard, OrganizationAuthContextGuard)
export class WorkspaceMoveController {
  constructor(
    private readonly workspaceMoveService: WorkspaceMoveService,
    private readonly workspacePlacementService: WorkspacePlacementService,
    private readonly sandboxRepository: SandboxRepository,
  ) {}

  @Post(':sandboxId/move')
  @HttpCode(200)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_RUNNERS])
  @ApiOperation({ summary: 'Request an idempotent workspace move', operationId: 'requestWorkspaceMove' })
  @ApiParam({ name: 'sandboxId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspaceOperationDto })
  async request(
    @IsOrganizationAuthContext() authContext: OrganizationAuthContext,
    @Param('sandboxId', ParseUUIDPipe) sandboxId: string,
    @Body() input: RequestWorkspaceMoveDto,
  ): Promise<WorkspaceOperationDto> {
    await this.assertSandboxOrganization(sandboxId, authContext.organizationId)
    const placement = await this.workspacePlacementService.findBySandboxId(sandboxId)
    if (!placement) throw new NotFoundException('Workspace placement not found')
    const operation = await this.workspaceMoveService.request({
      operationId: input.operationId,
      placementId: placement.id,
      volumeId: placement.volumeId,
      sandboxId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      expectedFenceEpoch: input.expectedFenceEpoch,
      idempotencyKey: input.idempotencyKey,
    })
    return WorkspaceOperationDto.fromOperation(operation)
  }

  @Get(':sandboxId/operations/:operationId')
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.READ_RUNNERS])
  @ApiOperation({ summary: 'Get workspace move status', operationId: 'getWorkspaceMove' })
  @ApiParam({ name: 'sandboxId', format: 'uuid' })
  @ApiParam({ name: 'operationId', format: 'uuid' })
  @ApiResponse({ status: 200, type: WorkspaceOperationDto })
  async get(
    @IsOrganizationAuthContext() authContext: OrganizationAuthContext,
    @Param('sandboxId', ParseUUIDPipe) sandboxId: string,
    @Param('operationId', ParseUUIDPipe) operationId: string,
  ): Promise<WorkspaceOperationDto> {
    await this.assertSandboxOrganization(sandboxId, authContext.organizationId)
    const operation = await this.workspaceMoveService.find(operationId)
    if (operation.sandboxId !== sandboxId) throw new NotFoundException('Workspace operation not found')
    return WorkspaceOperationDto.fromOperation(operation)
  }

  private async assertSandboxOrganization(sandboxId: string, organizationId: string): Promise<void> {
    const sandbox = await this.sandboxRepository.findOneBy({ id: sandboxId, organizationId })
    if (!sandbox) throw new NotFoundException('Sandbox not found')
  }
}
