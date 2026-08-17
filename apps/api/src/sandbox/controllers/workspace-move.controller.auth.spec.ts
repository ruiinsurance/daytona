/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { WorkspaceMoveController } from './workspace-move.controller'
import { OrganizationAuthContextGuard } from '../../organization/guards/organization-auth-context.guard'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import {
  createCoverageTracker,
  expectArrayMatch,
  getAllowedAuthStrategies,
  getAuthContextGuards,
  getRequiredOrganizationResourcePermissions,
  isPublicEndpoint,
} from '../../test/helpers/controller-metadata.helper'

describe('[AUTH] WorkspaceMoveController', () => {
  const trackMethod = createCoverageTracker(WorkspaceMoveController)

  it('requires organization auth and write runner permission for move requests', () => {
    const methodName = trackMethod('request')
    expect(isPublicEndpoint(WorkspaceMoveController, methodName)).toBe(false)
    expectArrayMatch(getAllowedAuthStrategies(WorkspaceMoveController, methodName), [
      AuthStrategyType.API_KEY,
      AuthStrategyType.JWT,
    ])
    expectArrayMatch(getAuthContextGuards(WorkspaceMoveController, methodName), [OrganizationAuthContextGuard])
    expectArrayMatch(getRequiredOrganizationResourcePermissions(WorkspaceMoveController, methodName), [
      OrganizationResourcePermission.WRITE_RUNNERS,
    ])
  })

  it('requires read runner permission for operation status', () => {
    const methodName = trackMethod('get')
    expect(isPublicEndpoint(WorkspaceMoveController, methodName)).toBe(false)
    expectArrayMatch(getAllowedAuthStrategies(WorkspaceMoveController, methodName), [
      AuthStrategyType.API_KEY,
      AuthStrategyType.JWT,
    ])
    expectArrayMatch(getAuthContextGuards(WorkspaceMoveController, methodName), [OrganizationAuthContextGuard])
    expectArrayMatch(getRequiredOrganizationResourcePermissions(WorkspaceMoveController, methodName), [
      OrganizationResourcePermission.READ_RUNNERS,
    ])
  })
})
