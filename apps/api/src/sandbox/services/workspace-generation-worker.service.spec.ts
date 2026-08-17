import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceGenerationReconciler,
  WorkspaceGenerationWorker,
} from './workspace-generation-worker.service'

const PLACEMENT_A = '11111111-1111-4111-8111-111111111111'
const PLACEMENT_B = '22222222-2222-4222-8222-222222222222'

function queryBuilder(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getMany: vi.fn().mockResolvedValue(rows),
  }
}

describe('WorkspaceGenerationWorker', () => {
  it('does not touch the database when generation storage is not explicitly configured', async () => {
    const reconciler = new WorkspaceGenerationReconciler(
      {} as any,
      {} as any,
      undefined,
      undefined,
      10,
    )
    const worker = new WorkspaceGenerationWorker(reconciler)

    await expect(worker.reconcileOnce()).resolves.toBe(0)
  })

  it('reconciles dirty and generation-lagging placements independently', async () => {
    const rows = [
      { id: PLACEMENT_A, dirty: true, localGeneration: '3', cosGeneration: '2' },
      { id: PLACEMENT_B, dirty: false, localGeneration: '4', cosGeneration: '3' },
    ]
    const builder = queryBuilder(rows)
    const placementRepository = { createQueryBuilder: vi.fn(() => builder) }
    const generationService = {
      reconcile: vi.fn()
        .mockRejectedValueOnce(new Error('fixed_generation_upload_failed'))
        .mockResolvedValueOnce({ outcome: 'committed' }),
    }
    const source = { create: vi.fn() }
    const store = { putObjects: vi.fn() }
    const reconciler = new WorkspaceGenerationReconciler(
      placementRepository as any,
      generationService as any,
      source as any,
      store as any,
      10,
    )

    await expect(reconciler.drainOnce()).resolves.toBe(1)
    expect(builder.where).toHaveBeenCalledWith(
      'placement.dirty = :dirty OR placement."localGeneration" > placement."cosGeneration"',
      { dirty: true },
    )
    expect(builder.take).toHaveBeenCalledWith(10)
    expect(generationService.reconcile).toHaveBeenNthCalledWith(1, {
      placementId: PLACEMENT_A,
      source,
      store,
    })
    expect(generationService.reconcile).toHaveBeenNthCalledWith(2, {
      placementId: PLACEMENT_B,
      source,
      store,
    })
  })
})
