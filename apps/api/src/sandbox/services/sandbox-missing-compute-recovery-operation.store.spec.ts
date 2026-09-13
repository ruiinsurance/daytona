/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { SandboxMissingComputeRecoveryOperationStore } from './sandbox-missing-compute-recovery-operation.store'

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
  computeCreated: true,
  workspace: request.workspace,
}

function redisHarness(evalResults: number[] = []) {
  const redis = {
    get: jest.fn(),
    eval: jest.fn().mockImplementation(async () => evalResults.shift() ?? 1),
  }
  return { redis, store: new SandboxMissingComputeRecoveryOperationStore(redis as never) }
}

describe('SandboxMissingComputeRecoveryOperationStore', () => {
  it('returns null when an operation has not been recorded', async () => {
    const { redis, store } = redisHarness()
    redis.get.mockResolvedValue(null)

    await expect(store.get(sandboxId, operationId)).resolves.toBeNull()
  })

  it('loads an exact running or completed operation for replay', async () => {
    for (const record of [
      { status: 'running', phase: 'compute_requested', operationId, sandboxId, request },
      { status: 'complete', phase: 'complete', operationId, sandboxId, request, result },
    ]) {
      const { redis, store } = redisHarness()
      redis.get.mockResolvedValue(JSON.stringify(record))
      await expect(store.get(sandboxId, operationId)).resolves.toEqual(record)
    }
  })

  it.each([
    { ...request, ownerRunnerId: '55555555-5555-4555-8555-555555555555' },
    { ...request, workspace: { ...request.workspace, volumeId: '66666666-6666-4666-8666-666666666666' } },
  ])('rejects completed evidence that differs from its recorded request', async (driftedRequest) => {
    const { redis, store } = redisHarness()
    redis.get.mockResolvedValue(
      JSON.stringify({
        status: 'complete',
        phase: 'complete',
        operationId,
        sandboxId,
        request,
        result: {
          ...result,
          ownerRunnerId: driftedRequest.ownerRunnerId,
          workspace: driftedRequest.workspace,
        },
      }),
    )

    await expect(store.get(sandboxId, operationId)).rejects.toThrow('Invalid missing-compute recovery operation record')
  })

  it('atomically begins, advances, completes, and aborts an owned operation', async () => {
    const { redis, store } = redisHarness([1, 1, 1, 1])

    await expect(store.begin(sandboxId, operationId, request)).resolves.toBe(true)
    await expect(store.advance(sandboxId, operationId, request, 'compute_requested')).resolves.toBeUndefined()
    await expect(store.complete(sandboxId, operationId, request, result)).resolves.toBeUndefined()
    await expect(store.abort(sandboxId, operationId)).resolves.toBeUndefined()

    expect(redis.eval).toHaveBeenCalledTimes(4)
    expect(redis.eval.mock.calls[0]).toEqual(
      expect.arrayContaining([
        2,
        `sandbox-missing-compute-recovery-active:${sandboxId}`,
        `sandbox-missing-compute-recovery-operation:${sandboxId}:${operationId}`,
        operationId,
      ]),
    )
  })

  it('reports contention and refuses to mutate after operation ownership is lost', async () => {
    const { store } = redisHarness([0, 0, 0])

    await expect(store.begin(sandboxId, operationId, request)).resolves.toBe(false)
    await expect(store.advance(sandboxId, operationId, request, 'compute_requested')).rejects.toThrow(
      'Missing-compute recovery operation ownership was lost',
    )
    await expect(store.complete(sandboxId, operationId, request, result)).rejects.toThrow(
      'Missing-compute recovery operation ownership was lost',
    )
  })
})
