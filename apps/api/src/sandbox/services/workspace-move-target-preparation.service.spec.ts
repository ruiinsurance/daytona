import { describe, expect, it, vi } from 'vitest'
import { WorkspaceMoveTargetPreparationService } from './workspace-move-target-preparation.service'

const SANDBOX_ID = '11111111-1111-4111-8111-111111111111'
const NODE_ID = '22222222-2222-4222-8222-222222222222'
const VOLUME_ID = '33333333-3333-4333-8333-333333333333'

function makeService() {
  const sandboxRepository = {
    findOne: vi.fn().mockResolvedValue({
      id: SANDBOX_ID,
      name: 'move-target-test',
      organizationId: '44444444-4444-4444-8444-444444444444',
      snapshot: null,
      buildInfo: {
        snapshotRef: 'build-ref:move-target',
        dockerfileContent: 'FROM ubuntu:22.04',
      },
      volumes: [
        { volumeId: VOLUME_ID, mountPath: '/workspace', subpath: `sandboxes/${SANDBOX_ID}/workspace` },
        { volumeId: VOLUME_ID, mountPath: '/config', subpath: `sandboxes/${SANDBOX_ID}/workspace` },
      ],
    }),
  }
  const storageNodeRepository = {
    findOne: vi.fn().mockResolvedValue({ nodeId: NODE_ID, runnerId: '55555555-5555-4555-8555-555555555555' }),
  }
  const runnerAdapter = { prepareSandbox: vi.fn().mockResolvedValue(undefined) }
  const service = new WorkspaceMoveTargetPreparationService(
    sandboxRepository as any,
    storageNodeRepository as any,
    { findOneOrFail: vi.fn().mockResolvedValue({ id: 'runner', region: 'region-test' }) } as any,
    { create: vi.fn().mockResolvedValue(runnerAdapter) } as any,
    {
      getEntrypointFromDockerfile: vi.fn().mockReturnValue(['/bin/sh']),
    } as any,
    {} as any,
    { findOne: vi.fn().mockResolvedValue({ sandboxMetadata: { feature: 'test' } }) } as any,
    { get: vi.fn().mockReturnValue(undefined) } as any,
  )
  return { service, runnerAdapter }
}

describe('WorkspaceMoveTargetPreparationService', () => {
  it('uses target runner metadata and passes stopped local-first evidence without changing placement', async () => {
    const { service, runnerAdapter } = makeService()

    await service.prepare({
      sandboxId: SANDBOX_ID,
      nodeId: NODE_ID,
      preparation: {
        volumeId: VOLUME_ID,
        nodeId: NODE_ID,
        fenceEpoch: '4',
        leaseOwner: 'move-worker:test',
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    })

    expect(runnerAdapter.prepareSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ id: SANDBOX_ID }),
      'build-ref:move-target',
      undefined,
      ['/bin/sh'],
      expect.objectContaining({ storageBackend: 'local-first' }),
      undefined,
      expect.objectContaining({ nodeId: NODE_ID, fenceEpoch: '4' }),
    )
  })

  it('redacts adapter failures to a fixed preparation category', async () => {
    const { service, runnerAdapter } = makeService()
    runnerAdapter.prepareSandbox.mockRejectedValue(new Error('credential-or-user-content'))

    await expect(
      service.prepare({
        sandboxId: SANDBOX_ID,
        nodeId: NODE_ID,
        preparation: {
          volumeId: VOLUME_ID,
          nodeId: NODE_ID,
          fenceEpoch: '4',
          leaseOwner: 'move-worker:test',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      }),
    ).rejects.toThrow('storage_agent_target_preparation_failed')
  })
})
