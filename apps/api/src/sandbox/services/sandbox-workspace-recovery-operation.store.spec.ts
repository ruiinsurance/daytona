/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SandboxWorkspaceRecoveryOperationStore } from './sandbox-workspace-recovery-operation.store'

const sandboxId = '11111111-1111-4111-8111-111111111111'
const operationId = '22222222-2222-4222-8222-222222222222'
const ownerRunnerId = '33333333-3333-4333-8333-333333333333'
const volumeId = '44444444-4444-4444-8444-444444444444'
const request = {
  operationId,
  ownerRunnerId,
  workspace: {
    volumeId,
    mountPath: '/workspace' as const,
    subpath: `sandboxes/${sandboxId}/workspace`,
  },
}
const result = {
  outcome: 'recovered' as const,
  operationId,
  sandboxId,
  externalId: sandboxId,
  ownerRunnerId,
  status: 'running' as const,
  workspace: request.workspace,
}

describe('SandboxWorkspaceRecoveryOperationStore', () => {
  it('loads an exact completed operation record', async () => {
    const redis = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: 'complete',
          phase: 'complete',
          operationId,
          sandboxId,
          request,
          result,
        }),
      ),
    }
    const store = new SandboxWorkspaceRecoveryOperationStore(redis as never)

    await expect(store.get(sandboxId, operationId)).resolves.toEqual({
      status: 'complete',
      phase: 'complete',
      operationId,
      sandboxId,
      request,
      result,
    })
  })

  it.each([
    { ...result, ownerRunnerId: '55555555-5555-4555-8555-555555555555' },
    { ...result, workspace: { ...result.workspace, volumeId: '66666666-6666-4666-8666-666666666666' } },
    { ...result, workspace: { ...result.workspace, subpath: 'sandboxes/other/workspace' } },
  ])('rejects completed evidence that drifts from the stored request', async (driftedResult) => {
    const redis = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify({
          status: 'complete',
          phase: 'complete',
          operationId,
          sandboxId,
          request,
          result: driftedResult,
        }),
      ),
    }
    const store = new SandboxWorkspaceRecoveryOperationStore(redis as never)

    await expect(store.get(sandboxId, operationId)).rejects.toThrow(
      'Invalid sandbox workspace recovery operation record',
    )
  })
})
