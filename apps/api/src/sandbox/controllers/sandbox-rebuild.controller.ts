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
import { RebuildSandboxDto } from '../dto/rebuild-sandbox.dto'
import { SandboxAccessGuard } from '../guards/sandbox-access.guard'
import { LocalSandboxRebuildResult, SandboxRebuildService } from '../services/sandbox-rebuild.service'

@Controller('sandbox')
@ApiTags('sandbox')
@ApiOAuth2(['openid', 'profile', 'email'])
@ApiBearerAuth()
@ApiHeader(CustomHeaders.ORGANIZATION_ID)
@AuthStrategy([AuthStrategyType.API_KEY, AuthStrategyType.JWT])
@UseGuards(AuthenticatedRateLimitGuard)
export class SandboxRebuildController {
  constructor(private readonly sandboxRebuildService: SandboxRebuildService) {}

  @Post(':sandboxId/rebuild')
  @HttpCode(HttpStatus.OK)
  @SkipThrottle({ authenticated: true })
  @ThrottlerScope('sandbox-lifecycle')
  @ApiOperation({
    summary: 'Rebuild a Runner-local sandbox on its existing owner and Volume',
    operationId: 'rebuildSandbox',
  })
  @ApiParam({ name: 'sandboxId', description: 'Stable sandbox UUID', type: 'string' })
  @UseGuards(OrganizationAuthContextGuard, SandboxAccessGuard)
  @RequiredOrganizationResourcePermissions([OrganizationResourcePermission.WRITE_SANDBOXES])
  @Audit({
    action: AuditAction.UPDATE,
    targetType: AuditTarget.SANDBOX,
    targetIdFromRequest: (req) => req.params.sandboxId,
    targetIdFromResult: (result) => result?.sandboxId,
  })
  async rebuildSandbox(
    @IsOrganizationAuthContext() authContext: OrganizationAuthContext,
    @Param('sandboxId') sandboxId: string,
    @Body() input: RebuildSandboxDto,
  ) {
    const result = await this.sandboxRebuildService.rebuild(sandboxId, authContext.organizationId, input)
    if (result.outcome === 'rebuilt') {
      return { success: true as const, code: result.outcome, ...result }
    }

    const { status, retryable } = this.failureResponse(result)
    throw new HttpException(
      {
        success: false,
        code: result.outcome,
        retryable,
        ...result,
      },
      status,
    )
  }

  private failureResponse(result: Exclude<LocalSandboxRebuildResult, { outcome: 'rebuilt' }>): {
    status: HttpStatus
    retryable: boolean
  } {
    switch (result.outcome) {
      case 'rebuild_preflight_failed':
      case 'rebuild_failed_previous_restored':
        return { status: HttpStatus.CONFLICT, retryable: true }
      case 'operation_in_progress':
        return { status: HttpStatus.CONFLICT, retryable: true }
      case 'rebuild_failed_rollback_failed':
      case 'operation_outcome_unknown':
        return { status: HttpStatus.INTERNAL_SERVER_ERROR, retryable: false }
    }
  }
}
