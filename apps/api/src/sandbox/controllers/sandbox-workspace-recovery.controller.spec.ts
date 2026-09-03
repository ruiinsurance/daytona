/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { HttpException, HttpStatus } from '@nestjs/common'
import { SandboxWorkspaceRecoveryController } from './sandbox-workspace-recovery.controller'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const organizationId = '22222222-2222-4222-8222-222222222222'
const operationId = '33333333-3333-4333-8333-333333333333'
const ownerRunnerId = '44444444-4444-4444-8444-444444444444'
const volumeId = '55555555-5555-4555-8555-555555555555'
const subpath = `sandboxes/${sandboxId}/workspace`
const request = {
  operationId,
  ownerRunnerId,
  workspace: { volumeId, mountPath: '/workspace' as const, subpath },
}

describe('SandboxWorkspaceRecoveryController', () => {
  it('returns strict same-identity recovery evidence', async () => {
    const result = {
      outcome: 'recovered' as const,
      operationId,
      sandboxId,
      externalId: sandboxId,
      ownerRunnerId,
      status: 'running' as const,
      workspace: request.workspace,
    }
    const service = { recover: jest.fn().mockResolvedValue(result) }
    const controller = new SandboxWorkspaceRecoveryController(service as never)

    await expect(controller.recoverWorkspace({ organizationId } as never, sandboxId, request)).resolves.toEqual({
      success: true,
      code: 'recovered',
      ...result,
    })
    expect(service.recover).toHaveBeenCalledWith(sandboxId, organizationId, request)
  })

  it('maps a concurrently owned operation to a fixed retryable conflict', async () => {
    const result = { outcome: 'operation_in_progress' as const, operationId, sandboxId }
    const service = { recover: jest.fn().mockResolvedValue(result) }
    const controller = new SandboxWorkspaceRecoveryController(service as never)

    let caught: unknown
    try {
      await controller.recoverWorkspace({ organizationId } as never, sandboxId, request)
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
