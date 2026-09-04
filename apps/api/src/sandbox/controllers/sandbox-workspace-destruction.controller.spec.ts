/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'
import { SandboxWorkspaceDestructionController } from './sandbox-workspace-destruction.controller'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const ownerRunnerId = '44444444-4444-4444-8444-444444444444'
const volumeId = '55555555-5555-4555-8555-555555555555'
const subpath = `sandboxes/${sandboxId}/workspace`
const input = { operationId, ownerRunnerId, volumeId, subpath }

describe('SandboxWorkspaceDestructionController', () => {
  it('returns exact workspace destruction evidence', async () => {
    const result = {
      outcome: 'workspace_destroyed' as const,
      operationId,
      sandboxId,
      ownerRunnerId,
      computeDestroyed: true as const,
      workspace: { volumeId, mountPath: '/workspace' as const, subpath },
      removalOutcome: 'removed' as const,
    }
    const service = { destroy: jest.fn().mockResolvedValue(result) }
    const controller = new SandboxWorkspaceDestructionController(service as never)

    await expect(controller.destroyWorkspace({ organizationId } as never, sandboxId, input)).resolves.toEqual({
      success: true,
      code: 'workspace_destroyed',
      ...result,
    })
    expect(service.destroy).toHaveBeenCalledWith(sandboxId, organizationId, input)
  })

  it('maps an in-progress replay to a retryable conflict', async () => {
    const result = { outcome: 'operation_in_progress' as const, operationId, sandboxId }
    const controller = new SandboxWorkspaceDestructionController({
      destroy: jest.fn().mockResolvedValue(result),
    } as never)

    let caught: unknown
    try {
      await controller.destroyWorkspace({ organizationId } as never, sandboxId, input)
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(HttpException)
    const error = caught as HttpException
    expect(error.getStatus()).toBe(HttpStatus.CONFLICT)
    expect(error.getResponse()).toEqual({
      success: false,
      code: 'operation_in_progress',
      retryable: true,
      ...result,
    })
  })
})
