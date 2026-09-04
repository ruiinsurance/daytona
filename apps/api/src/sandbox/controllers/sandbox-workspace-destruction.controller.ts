/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Body, Controller, HttpCode, HttpException, HttpStatus, Param, Post, UseGuards } from '@nestjs/common'
import { ApiBearerAuth, ApiHeader, ApiOAuth2, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger'
import { SkipThrottle } from '@nestjs/throttler'
import { Audit } from '../../audit/decorators/audit.decorator'
import { AuditAction } from '../../audit/enums/audit-action.enum'
import { AuditTarget } from '../../audit/enums/audit-target.enum'
import { AuthStrategy } from '../../auth/decorators/auth-strategy.decorator'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import { CustomHeaders } from '../../common/constants/header.constants'
import { IsOrganizationAuthContext } from '../../common/decorators/auth-context.decorator'
import { ThrottlerScope } from '../../common/decorators/throttler-scope.decorator'
import { AuthenticatedRateLimitGuard } from '../../common/guards/authenticated-rate-limit.guard'
import { OrganizationAuthContext } from '../../common/interfaces/organization-auth-context.interface'
import { RequiredOrganizationResourcePermissions } from '../../organization/decorators/required-organization-resource-permissions.decorator'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import { OrganizationAuthContextGuard } from '../../organization/guards/organization-auth-context.guard'
import { DestroySandboxWorkspaceDto } from '../dto/destroy-sandbox-workspace.dto'
import { SandboxWorkspaceDestructionService } from '../services/sandbox-workspace-destruction.service'

@Controller('sandbox')
@ApiTags('sandbox')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@AuthStrategy([AuthStrategyType.API_KEY])
@UseGuards(AuthenticatedRateLimitGuard)
export class SandboxWorkspaceDestructionController {
  constructor(private readonly service: SandboxWorkspaceDestructionService) {}

  @Post(':sandboxId/destroy-workspace')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('sandbox-lifecycle')
  @ApiOperation({
    summary: 'Destroy one exact Runner-local sandbox workspace slice',
    operationId: 'destroySandboxWorkspace',
  })
  @ApiParam({ name: 'sandboxId', description: 'Stable sandbox UUID', type: 'string' })
  @UseGuards(OrganizationAuthContextGuard)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_SANDBOXES])
  @Audit({
    action: AuditAction.DELETE,
    targetType: AuditTarget.SANDBOX,
    targetIdFromRequest: (req) => req.params.sandboxId,
    targetIdFromResult: (result) => result?.sandboxId,
  })
  async destroyWorkspace(
    @IsOrganizationAuthContext() authContext: OrganizationAuthContext,
    @Param('sandboxId') sandboxId: string,
    @Body() input: DestroySandboxWorkspaceDto,
  ) {
    const result = await this.service.destroy(sandboxId, authContext.organizationId, input)
    if (result.outcome === 'workspace_destroyed') {
      return { success: true as const, code: result.outcome, ...result }
    }
    throw new HttpException({ success: false, code: result.outcome, retryable: true, ...result }, HttpStatus.CONFLICT)
  }
}
