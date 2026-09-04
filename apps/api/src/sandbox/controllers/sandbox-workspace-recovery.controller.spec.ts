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
const workspace = { volumeId, mountPath: '/workspace' as const, subpath: `sandboxes/${sandboxId}/workspace` }
const input = { operationId, ownerRunnerId, workspace }

describe('SandboxWorkspaceRecoveryController', () => {
  it('returns the exact stable-identity recovery evidence expected by Suna', async () => {
    const result = {
      outcome: 'recovered' as const,
      operationId,
      sandboxId,
      externalId: sandboxId,
      ownerRunnerId,
      status: 'running' as const,
      workspace,
    }
    const service = { recover: jest.fn().mockResolvedValue(result) }
    const controller = new SandboxWorkspaceRecoveryController(service as never)

    await expect(controller.recoverWorkspace({ organizationId } as never, sandboxId, input)).resolves.toEqual({
      success: true,
      code: 'recovered',
      ...result,
    })
    expect(service.recover).toHaveBeenCalledWith(sandboxId, organizationId, input)
  })

  it('returns HTTP 202 with a fixed retryable in-progress response', async () => {
    const result = { outcome: 'operation_in_progress' as const, operationId, sandboxId }
    const controller = new SandboxWorkspaceRecoveryController({
      recover: jest.fn().mockResolvedValue(result),
    } as never)

    let caught: unknown
    try {
      await controller.recoverWorkspace({ organizationId } as never, sandboxId, input)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(HttpException)
    const response = caught as HttpException
    expect(response.getStatus()).toBe(HttpStatus.ACCEPTED)
    expect(response.getResponse()).toEqual({
      success: false,
      code: 'operation_in_progress',
      retryable: true,
      ...result,
    })
  })
})
