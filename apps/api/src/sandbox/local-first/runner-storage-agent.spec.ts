import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'

vi.mock('../entities/runner.entity', () => ({ Runner: class Runner {} }))
vi.mock('../entities/storage-node.entity', () => ({ StorageNode: class StorageNode {} }))

import { checkpointContentHash, manifestHash, type ImmutableCheckpoint } from './workspace-generation.contract'
import {
  RunnerStorageAgentCheckpointSource,
  RunnerStorageAgentClient,
  RunnerStorageAgentMoveRuntime,
} from './runner-storage-agent'

const NODE_ID = '11111111-1111-4111-8111-111111111111'
const VOLUME_ID = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'
const OPERATION_ID = '44444444-4444-4444-8444-444444444444'
const LEASE_EXPIRES_AT = new Date('2099-01-01T00:00:00.000Z')

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function fixtureCheckpoint(): ImmutableCheckpoint {
  const body = Buffer.from('state')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const objects = [{ key: 'state.db', body, size: body.byteLength, sha256 }]
  return {
    sourcePath: `runner-local-first:${NODE_ID}`,
    generation: '7',
    manifest: {
      formatVersion: 1,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      generation: '7',
      objectCount: 1,
      bytes: body.byteLength,
      contentHash: checkpointContentHash(objects),
      createdAt: '2026-08-17T00:00:00.000Z',
    },
    objects,
  }
}

function client() {
  return new RunnerStorageAgentClient(
    { findOne: vi.fn().mockResolvedValue({ nodeId: NODE_ID, runnerId: 'runner-1' }) } as any,
    { findOne: vi.fn().mockResolvedValue({ apiUrl: 'http://runner.test:8080', apiKey: 'runner-secret' }) } as any,
  )
}

describe('RunnerStorageAgentClient', () => {
  it('uses the authenticated Runner endpoint and validates checkpoint bytes', async () => {
    const checkpoint = fixtureCheckpoint()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        generation: checkpoint.generation,
        manifest: checkpoint.manifest,
        objects: [
          {
            key: 'state.db',
            body: Buffer.from('state').toString('base64'),
            size: 5,
            sha256: checkpoint.objects[0].sha256,
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await client().checkpoint({
      nodeId: NODE_ID,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      generation: '7',
      lease: {
        operationId: OPERATION_ID,
        fenceEpoch: '4',
        leaseOwner: `move-worker:${OPERATION_ID}`,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    expect(result.manifest).toEqual(checkpoint.manifest)
    expect(Buffer.from(result.objects[0].body).toString()).toBe('state')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, request] = fetchMock.mock.calls[0]
    expect(url.toString()).toBe('http://runner.test:8080/storage/workspaces/checkpoint')
    expect(request.headers.Authorization).toMatch(/^Bearer /)
    const requestBody = JSON.parse(request.body as string)
    expect(requestBody).toMatchObject({ nodeId: NODE_ID, volumeId: VOLUME_ID, generation: '7' })
    expect(requestBody).not.toHaveProperty('sourcePath')
  })

  it.each([
    'storage_agent_container_inspect_failed',
    'storage_agent_mount_prepare_failed',
    'storage_agent_container_start_failed',
    'storage_agent_container_readiness_failed',
    'storage_agent_mount_verification_failed',
    'storage_agent_start_failed',
    'storage_identity_invalid',
    'storage_node_identity_mismatch',
    'workspace_fence_invalid',
    'workspace_lease_expired',
    'workspace_fence_state_unavailable',
    'workspace_fence_state_invalid',
    'stale_workspace_fence',
    'workspace_quiesce_conflict',
    'workspace_lock_unavailable',
  ])('preserves the fixed Runner start category %s', async (code) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ code }),
      }),
    )

    await expect(
      client().start({
        nodeId: NODE_ID,
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        lease: {
          operationId: OPERATION_ID,
          fenceEpoch: '4',
          leaseOwner: `move-worker:${OPERATION_ID}`,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toThrow(code)
  })

  it('does not expose an unknown Runner error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ code: 'storage_agent_secret_material' }),
      }),
    )

    await expect(
      client().start({
        nodeId: NODE_ID,
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        lease: {
          operationId: OPERATION_ID,
          fenceEpoch: '4',
          leaseOwner: `move-worker:${OPERATION_ID}`,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toThrow('storage_agent_request_failed')
  })

  it('rejects a payload whose object hash does not match before it reaches COS', async () => {
    const checkpoint = fixtureCheckpoint()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          generation: checkpoint.generation,
          manifest: checkpoint.manifest,
          objects: [
            {
              key: 'state.db',
              body: Buffer.from('tampered').toString('base64'),
              size: 8,
              sha256: checkpoint.objects[0].sha256,
            },
          ],
        }),
      }),
    )

    await expect(
      client().checkpoint({
        nodeId: NODE_ID,
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        generation: '7',
        lease: {
          operationId: OPERATION_ID,
          fenceEpoch: '4',
          leaseOwner: `move-worker:${OPERATION_ID}`,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toThrow('storage_agent_payload_invalid')
  })

  it('rejects a checkpoint response for a different logical workspace', async () => {
    const checkpoint = fixtureCheckpoint()
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          generation: checkpoint.generation,
          manifest: { ...checkpoint.manifest, sandboxId: OPERATION_ID },
          objects: [
            {
              key: 'state.db',
              body: Buffer.from('state').toString('base64'),
              size: 5,
              sha256: checkpoint.objects[0].sha256,
            },
          ],
        }),
      }),
    )

    await expect(
      client().checkpoint({
        nodeId: NODE_ID,
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        generation: '7',
        lease: {
          operationId: OPERATION_ID,
          fenceEpoch: '4',
          leaseOwner: `move-worker:${OPERATION_ID}`,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toThrow('storage_agent_payload_invalid')
  })

  it('rejects a target verification response with a stale generation or malformed hash', async () => {
    const checkpoint = fixtureCheckpoint()
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ generation: '6', manifestHash: 'not-a-hash' }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const agentClient = client()

    await expect(
      agentClient.verify({
        nodeId: NODE_ID,
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        checkpoint,
        lease: {
          operationId: OPERATION_ID,
          fenceEpoch: '4',
          leaseOwner: `move-worker:${OPERATION_ID}`,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toThrow('storage_agent_payload_invalid')
  })
})

describe('RunnerStorageAgentCheckpointSource', () => {
  it('requires the Daytona-owned placement node before creating a checkpoint', async () => {
    const checkpoint = fixtureCheckpoint()
    const checkpointMock = vi.fn().mockResolvedValue(checkpoint)
    const source = new RunnerStorageAgentCheckpointSource({ checkpoint: checkpointMock } as any)

    const result = await source.create({
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      sourcePath: '/ignored-by-runner-agent',
      nextGeneration: '7',
      ownerNodeId: NODE_ID,
      operationId: OPERATION_ID,
      fenceEpoch: '4',
      leaseOwner: `generation-worker:${OPERATION_ID}`,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    })

    expect(result).toBe(checkpoint)
    expect(checkpointMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: NODE_ID,
        generation: '7',
        lease: expect.objectContaining({ operationId: OPERATION_ID, fenceEpoch: '4' }),
      }),
    )
  })

  it('rejects a checkpoint request without control-plane lease evidence', async () => {
    const source = new RunnerStorageAgentCheckpointSource({ checkpoint: vi.fn() } as any)

    await expect(
      source.create({
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        sourcePath: '/ignored-by-runner-agent',
        nextGeneration: '7',
        ownerNodeId: NODE_ID,
      }),
    ).rejects.toThrow('storage_agent_lease_missing')
  })
})

describe('RunnerStorageAgentMoveRuntime', () => {
  it('does not derive a checkpoint generation from the fencing epoch', async () => {
    const agentClient = { checkpoint: vi.fn() }
    const runtime = new RunnerStorageAgentMoveRuntime(agentClient as any, {} as any, {} as any)
    const operation = {
      id: OPERATION_ID,
      placementId: '55555555-5555-4555-8555-555555555555',
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      sourceNodeId: NODE_ID,
      targetNodeId: '66666666-6666-4666-8666-666666666666',
      expectedFenceEpoch: '99',
    }

    await expect(
      runtime.checkpoint({
        operation,
        fenceEpoch: '99',
        checkpointGeneration: null,
        targetGeneration: null,
      } as any),
    ).rejects.toThrow('move_checkpoint_generation_missing')
    expect(agentClient.checkpoint).not.toHaveBeenCalled()
  })

  it.each([null, new Date('invalid'), new Date('2000-01-01T00:00:00.000Z')])(
    'fails closed when the move operation has no valid authoritative lease expiry',
    async (leaseExpiresAt) => {
      const agentClient = { quiesce: vi.fn() }
      const runtime = new RunnerStorageAgentMoveRuntime(agentClient as any, {} as any, {} as any)
      const operation = {
        id: OPERATION_ID,
        placementId: '55555555-5555-4555-8555-555555555555',
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        sourceNodeId: NODE_ID,
        targetNodeId: '66666666-6666-4666-8666-666666666666',
        expectedFenceEpoch: '4',
        leaseOwner: `move-worker:test:${OPERATION_ID}`,
        leaseExpiresAt,
      }

      await expect(
        runtime.quiesce({
          operation,
          fenceEpoch: '4',
          checkpointGeneration: '7',
          targetGeneration: null,
        } as any),
      ).rejects.toThrow('workspace_lease_invalid')
      expect(agentClient.quiesce).not.toHaveBeenCalled()
    },
  )

  it('runs quiesce, checkpoint, copy, target verification, fenced start, and retention', async () => {
    const checkpoint = fixtureCheckpoint()
    const agentClient = {
      fence: vi.fn().mockResolvedValue(undefined),
      quiesce: vi.fn().mockResolvedValue(undefined),
      checkpoint: vi.fn().mockResolvedValue(checkpoint),
      import: vi.fn().mockResolvedValue(undefined),
      verify: vi.fn().mockResolvedValue({ generation: '7', manifestHash: manifestHash(checkpoint.manifest) }),
      start: vi.fn().mockResolvedValue(undefined),
      retain: vi.fn().mockResolvedValue(undefined),
    }
    const placementService = {
      acquireWriterLease: vi.fn().mockResolvedValue({ leaseExpiresAt: new Date(Date.now() + 60_000) }),
    }
    const runtime = new RunnerStorageAgentMoveRuntime(agentClient as any, placementService as any, {} as any)
    const operation = {
      id: OPERATION_ID,
      placementId: '55555555-5555-4555-8555-555555555555',
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      sourceNodeId: NODE_ID,
      targetNodeId: '66666666-6666-4666-8666-666666666666',
      expectedFenceEpoch: '4',
      leaseOwner: `move-worker:test:${OPERATION_ID}`,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    }
    const input = { operation, fenceEpoch: '5', checkpointGeneration: '7', targetGeneration: null } as any

    await runtime.quiesce(input)
    await expect(runtime.checkpoint(input)).resolves.toEqual({ generation: '7' })
    await runtime.copy({ ...input, checkpointGeneration: '7' })
    await expect(runtime.verifyTarget({ ...input, checkpointGeneration: '7' })).resolves.toEqual({
      generation: '7',
      manifestHash: manifestHash(checkpoint.manifest),
    })
    await runtime.startTarget({ ...input, checkpointGeneration: '7' })
    await runtime.retainSource({ ...input, checkpointGeneration: '7' })

    expect(agentClient.quiesce).toHaveBeenCalled()
    expect(agentClient.quiesce).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ leaseExpiresAt: LEASE_EXPIRES_AT.toISOString() }),
      }),
    )
    expect(agentClient.fence).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: operation.sourceNodeId,
        lease: expect.objectContaining({
          fenceEpoch: '5',
          leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
        }),
      }),
    )
    expect(agentClient.checkpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({ leaseExpiresAt: LEASE_EXPIRES_AT.toISOString() }),
      }),
    )
    expect(agentClient.import).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: operation.targetNodeId,
        lease: expect.objectContaining({ leaseExpiresAt: LEASE_EXPIRES_AT.toISOString() }),
      }),
    )
    expect(agentClient.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: operation.targetNodeId,
        lease: expect.objectContaining({ leaseExpiresAt: LEASE_EXPIRES_AT.toISOString() }),
      }),
    )
    expect(placementService.acquireWriterLease).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: operation.targetNodeId,
        fenceEpoch: 5,
      }),
    )
    expect(agentClient.start).toHaveBeenCalled()
    expect(agentClient.retain).toHaveBeenCalled()
    expect(agentClient.retain).toHaveBeenCalledWith(
      expect.objectContaining({
        lease: expect.objectContaining({
          fenceEpoch: '5',
          leaseExpiresAt: LEASE_EXPIRES_AT.toISOString(),
        }),
      }),
    )
  })

  it('fences the target before asking the control plane to create a stopped container', async () => {
    const agentClient = { fence: vi.fn().mockResolvedValue(undefined) }
    const targetPreparation = { prepare: vi.fn().mockResolvedValue(undefined) }
    const runtime = new RunnerStorageAgentMoveRuntime(agentClient as any, {} as any, targetPreparation as any)
    const operation = {
      id: OPERATION_ID,
      placementId: '55555555-5555-4555-8555-555555555555',
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      sourceNodeId: NODE_ID,
      targetNodeId: '66666666-6666-4666-8666-666666666666',
      expectedFenceEpoch: '4',
      leaseOwner: `move-worker:test:${OPERATION_ID}`,
      leaseExpiresAt: LEASE_EXPIRES_AT,
    }

    await runtime.prepareTarget({ operation, fenceEpoch: '4', checkpointGeneration: '7', targetGeneration: '7' } as any)

    expect(agentClient.fence).toHaveBeenCalledWith(expect.objectContaining({ nodeId: operation.targetNodeId }))
    expect(targetPreparation.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxId: SANDBOX_ID,
        nodeId: operation.targetNodeId,
        preparation: expect.objectContaining({ fenceEpoch: '4', volumeId: VOLUME_ID }),
      }),
    )
  })
})
