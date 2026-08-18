/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { describe, expect, it } from 'vitest'
import { StorageNodeController } from './storage-node.controller'
import { OrganizationAuthContextGuard } from '../../organization/guards/organization-auth-context.guard'
import { RunnerAccessGuard } from '../guards/runner-access.guard'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import { OrganizationResourcePermission } from '../../organization/enums/organization-resource-permission.enum'
import {
  getAuthContextGuards,
  getAllowedAuthStrategies,
  getResourceAccessGuards,
  getRequiredOrganizationMemberRole,
  getRequiredOrganizationResourcePermissions,
  expectArrayMatch,
  createCoverageTracker,
  isPublicEndpoint,
} from '../../test/helpers/controller-metadata.helper'

describe('[AUTH] StorageNodeController', () => {
  const trackMethod = createCoverageTracker(StorageNodeController)

  it('getStatus', () => {
    const methodName = trackMethod('getStatus')
    expect(isPublicEndpoint(StorageNodeController, methodName)).toBe(false)
    expectArrayMatch(getAllowedAuthStrategies(StorageNodeController, methodName), [
      AuthStrategyType.API_KEY,
      AuthStrategyType.JWT,
    ])
    expectArrayMatch(getAuthContextGuards(StorageNodeController, methodName), [OrganizationAuthContextGuard])
    expectArrayMatch(getResourceAccessGuards(StorageNodeController, methodName), [RunnerAccessGuard])
    expect(getRequiredOrganizationMemberRole(StorageNodeController, methodName)).toBeUndefined()
    expectArrayMatch(getRequiredOrganizationResourcePermissions(StorageNodeController, methodName), [
      OrganizationResourcePermission.READ_RUNNERS,
    ])
  })

  for (const methodName of ['activate', 'cordon', 'drain', 'remove'] as const) {
    it(methodName, () => {
      const trackedMethod = trackMethod(methodName)
      expect(isPublicEndpoint(StorageNodeController, trackedMethod)).toBe(false)
      expectArrayMatch(getAllowedAuthStrategies(StorageNodeController, trackedMethod), [
        AuthStrategyType.API_KEY,
        AuthStrategyType.JWT,
      ])
      expectArrayMatch(getAuthContextGuards(StorageNodeController, trackedMethod), [OrganizationAuthContextGuard])
      expectArrayMatch(getResourceAccessGuards(StorageNodeController, trackedMethod), [RunnerAccessGuard])
      expect(getRequiredOrganizationMemberRole(StorageNodeController, trackedMethod)).toBeUndefined()
      expectArrayMatch(getRequiredOrganizationResourcePermissions(StorageNodeController, trackedMethod), [
        OrganizationResourcePermission.WRITE_RUNNERS,
      ])
    })
  }
})
