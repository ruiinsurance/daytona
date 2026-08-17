/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { afterAll, describe, expect, it } from 'vitest'
import { StorageNodeRunnerController } from './storage-node-runner.controller'
import { RunnerAuthContextGuard } from '../guards/runner-auth-context.guard'
import { AuthStrategyType } from '../../auth/enums/auth-strategy-type.enum'
import {
  getAuthContextGuards,
  getAllowedAuthStrategies,
  getRequiredOrganizationMemberRole,
  createCoverageTracker,
  expectArrayMatch,
  isPublicEndpoint,
} from '../../test/helpers/controller-metadata.helper'

describe('[AUTH] StorageNodeRunnerController', () => {
  const trackMethod = createCoverageTracker(StorageNodeRunnerController)

  it('register', () => {
    const methodName = trackMethod('register')
    expect(isPublicEndpoint(StorageNodeRunnerController, methodName)).toBe(false)
    expectArrayMatch(getAllowedAuthStrategies(StorageNodeRunnerController, methodName), [AuthStrategyType.API_KEY])
    expectArrayMatch(getAuthContextGuards(StorageNodeRunnerController, methodName), [RunnerAuthContextGuard])
    expect(getRequiredOrganizationMemberRole(StorageNodeRunnerController, methodName)).toBeUndefined()
  })

  it('heartbeat', () => {
    const methodName = trackMethod('heartbeat')
    expect(isPublicEndpoint(StorageNodeRunnerController, methodName)).toBe(false)
    expectArrayMatch(getAllowedAuthStrategies(StorageNodeRunnerController, methodName), [AuthStrategyType.API_KEY])
    expectArrayMatch(getAuthContextGuards(StorageNodeRunnerController, methodName), [RunnerAuthContextGuard])
    expect(getRequiredOrganizationMemberRole(StorageNodeRunnerController, methodName)).toBeUndefined()
  })
})
