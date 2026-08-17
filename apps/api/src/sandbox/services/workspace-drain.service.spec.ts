import { describe, expect, it, vi } from 'vitest'
import { WorkspaceDrainService } from './workspace-drain.service'

const NODE_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_NODE_ID = '22222222-2222-4222-8222-222222222222'
const PLACEMENT_ID = '33333333-3333-4333-8333-333333333333'
const SANDBOX_ID = '44444444-4444-4444-8444-444444444444'
const VOLUME_ID = '55555555-5555-4555-8555-555555555555'

function makeService(placements: any[], targetAvailable = true) {
  const storageNodeRepository = {
    find: vi.fn().mockResolvedValue([{ nodeId: NODE_ID, runnerId: 'runner-1', state: 'draining' }]),
  }
  const placementRepository = {
    find: vi.fn().mockResolvedValue(placements),
  }
  const storageNodeService = {
    chooseNode: vi.fn().mockImplementation(async () => {
      if (!targetAvailable) throw new Error('no_schedulable_storage_node')
      return { nodeId: TARGET_NODE_ID, reason: 'capacity_score' }
    }),
    transition: vi.fn().mockResolvedValue(undefined),
  }
  const workspaceMoveService = {
    request: vi.fn().mockResolvedValue({ phase: 'requested' }),
    hasBlockingOperations: vi.fn().mockResolvedValue(false),
  }
  return {
    service: new WorkspaceDrainService(
      storageNodeRepository as any,
      placementRepository as any,
      storageNodeService as any,
      workspaceMoveService as any,
    ),
    storageNodeService,
    workspaceMoveService,
  }
}

describe('WorkspaceDrainService', () => {
  it('creates bounded, idempotent control-plane moves for owned placements', async () => {
    const placement = {
      id: PLACEMENT_ID,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      ownerNodeId: NODE_ID,
      fenceEpoch: '3',
    }
    const { service, workspaceMoveService } = makeService([placement])

    await expect(service.reconcileOnce(1)).resolves.toEqual({ requested: 1, drained: 0 })
    expect(workspaceMoveService.request).toHaveBeenCalledWith(expect.objectContaining({
      placementId: PLACEMENT_ID,
      sourceNodeId: NODE_ID,
      targetNodeId: TARGET_NODE_ID,
      expectedFenceEpoch: '3',
      idempotencyKey: `drain:${NODE_ID}:${PLACEMENT_ID}`,
    }))
  })

  it('marks a node drained only after its owner set is empty and no move blocks it', async () => {
    const { service, storageNodeService } = makeService([])

    await expect(service.reconcileOnce()).resolves.toEqual({ requested: 0, drained: 1 })
    expect(storageNodeService.transition).toHaveBeenCalledWith(NODE_ID, 'drained', 'runner-1')
  })

  it('keeps draining when no target is schedulable', async () => {
    const { service, storageNodeService, workspaceMoveService } = makeService([{
      id: PLACEMENT_ID,
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      ownerNodeId: NODE_ID,
      fenceEpoch: '3',
    }], false)

    await expect(service.reconcileOnce()).resolves.toEqual({ requested: 0, drained: 0 })
    expect(workspaceMoveService.request).not.toHaveBeenCalled()
    expect(storageNodeService.transition).not.toHaveBeenCalled()
  })
})
