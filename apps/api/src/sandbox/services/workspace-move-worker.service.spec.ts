import { describe, expect, it, vi } from 'vitest'
import {
  WorkspaceMoveReconciler,
  WorkspaceMoveWorker,
} from './workspace-move-worker.service'

const OPERATION_A = '11111111-1111-4111-8111-111111111111'
const OPERATION_B = '22222222-2222-4222-8222-222222222222'

function queryBuilder(rows: unknown[]) {
  return {
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    take: vi.fn().mockReturnThis(),
    getMany: vi.fn().mockResolvedValue(rows),
  }
}

describe('WorkspaceMoveWorker', () => {
  it('does not touch the database when no storage-agent runtime is configured', async () => {
    const reconciler = new WorkspaceMoveReconciler({} as any, {} as any, undefined, 10)
    const worker = new WorkspaceMoveWorker(reconciler)

    await expect(worker.reconcileOnce()).resolves.toBe(0)
  })

  it('resumes non-terminal operations independently and counts only completed moves', async () => {
    const builder = queryBuilder([
      { id: OPERATION_A, phase: 'copying' },
      { id: OPERATION_B, phase: 'target_started' },
    ])
    const operationRepository = { createQueryBuilder: vi.fn(() => builder) }
    const moveService = {
      run: vi.fn()
        .mockRejectedValueOnce(new Error('fixed_move_phase_failed'))
        .mockResolvedValueOnce({ phase: 'complete' }),
    }
    const runtime = {}
    const reconciler = new WorkspaceMoveReconciler(
      operationRepository as any,
      moveService as any,
      runtime as any,
      10,
    )

    await expect(reconciler.drainOnce()).resolves.toBe(1)
    expect(builder.where).toHaveBeenCalledWith('operation.phase <> :complete', { complete: 'complete' })
    expect(moveService.run).toHaveBeenNthCalledWith(1, OPERATION_A, runtime)
    expect(moveService.run).toHaveBeenNthCalledWith(2, OPERATION_B, runtime)
  })
})
