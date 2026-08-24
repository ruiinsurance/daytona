/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'
import { SandboxRebuildController } from './sandbox-rebuild.controller'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'

describe('SandboxRebuildController', () => {
  it('exposes the stable same-owner rebuild result through the public API', async () => {
    const rebuildResult = {
      outcome: 'rebuilt' as const,
      operationId,
      sandboxId,
      ownerRunnerId: '44444444-4444-4444-8444-444444444444',
      previousSnapshot: 'previous-snapshot',
      targetSnapshot: 'target-snapshot',
    }
    const rebuildService = { rebuild: jest.fn().mockResolvedValue(rebuildResult) }
    const controller = new SandboxRebuildController(rebuildService as never)

    await expect(
      controller.rebuildSandbox({ organizationId } as never, sandboxId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      }),
    ).resolves.toEqual({
      success: true,
      code: 'rebuilt',
      ...rebuildResult,
    })

    expect(rebuildService.rebuild).toHaveBeenCalledWith(sandboxId, organizationId, {
      operationId,
      targetSnapshot: 'target-snapshot',
    })
  })

  it.each([
    ['rebuild_preflight_failed', HttpStatus.CONFLICT, true],
    ['rebuild_failed_previous_restored', HttpStatus.CONFLICT, true],
    ['operation_in_progress', HttpStatus.CONFLICT, true],
    ['rebuild_failed_rollback_failed', HttpStatus.INTERNAL_SERVER_ERROR, false],
    ['operation_outcome_unknown', HttpStatus.INTERNAL_SERVER_ERROR, false],
  ] as const)('maps %s to a fixed public failure response', async (outcome, status, retryable) => {
    const rebuildResult = {
      outcome,
      operationId,
      sandboxId,
      targetSnapshot: 'target-snapshot',
    }
    const rebuildService = { rebuild: jest.fn().mockResolvedValue(rebuildResult) }
    const controller = new SandboxRebuildController(rebuildService as never)

    let caught: unknown
    try {
      await controller.rebuildSandbox({ organizationId } as never, sandboxId, {
        operationId,
        targetSnapshot: 'target-snapshot',
      })
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HttpException)
    const error = caught as HttpException
    expect(error.getStatus()).toBe(status)
    expect(error.getResponse()).toEqual({
      success: false,
      code: outcome,
      retryable,
      ...rebuildResult,
    })
  })
})
