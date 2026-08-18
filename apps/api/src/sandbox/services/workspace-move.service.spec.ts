import { describe, expect, it, vi } from 'vitest'
import { WorkspaceMoveService } from './workspace-move.service'

const OPERATION_ID = '11111111-1111-4111-8111-111111111111'
const PLACEMENT_ID = '22222222-2222-4222-8222-222222222222'
const VOLUME_ID = '33333333-3333-4333-8333-333333333333'
const SANDBOX_ID = '44444444-4444-4444-8444-444444444444'
const SOURCE_NODE_ID = '55555555-5555-4555-8555-555555555555'
const TARGET_NODE_ID = '66666666-6666-4666-8666-666666666666'

function makeService() {
  const placement = {
    id: PLACEMENT_ID,
    volumeId: VOLUME_ID,
    sandboxId: SANDBOX_ID,
    ownerNodeId: SOURCE_NODE_ID,
    fenceEpoch: '3',
    localGeneration: '3',
    cosGeneration: '3',
  }
  const operations: any[] = []
  const saveSnapshots: any[] = []
  const claimExecutions: any[] = []
  const operationRepository = {
    findOne: vi.fn(
      async ({ where }: any) =>
        operations.find(
          (row) =>
            (where.id && row.id === where.id) ||
            (where.idempotencyKey && row.idempotencyKey === where.idempotencyKey) ||
            (where.placementId && row.placementId === where.placementId),
        ) ?? null,
    ),
    find: vi.fn(async () => operations),
    create: vi.fn((value) => value),
    save: vi.fn(async (value) => {
      saveSnapshots.push(structuredClone(value))
      const index = operations.findIndex((row) => row.id === value.id)
      if (index === -1) operations.push(value)
      else operations[index] = value
      return value
    }),
    createQueryBuilder: vi.fn(() => {
      const state: { values?: Record<string, unknown>; params: Record<string, unknown> } = { params: {} }
      const builder = {
        update: vi.fn().mockReturnThis(),
        set: vi.fn((values) => {
          state.values = values
          return builder
        }),
        where: vi.fn((_query, params) => {
          Object.assign(state.params, params)
          return builder
        }),
        andWhere: vi.fn((_query, params) => {
          Object.assign(state.params, params)
          return builder
        }),
        returning: vi.fn().mockReturnThis(),
        execute: vi.fn(async () => {
          claimExecutions.push({ values: state.values, params: state.params })
          const operation = operations.find((row) => row.id === state.params.operationId)
          if (!operation) return { raw: [], affected: 0 }
          const now = state.params.now as Date
          const expiresAt =
            operation.leaseExpiresAt instanceof Date
              ? operation.leaseExpiresAt
              : operation.leaseExpiresAt
                ? new Date(operation.leaseExpiresAt)
                : null
          if (
            operation.leaseOwner &&
            operation.leaseOwner !== state.params.leaseOwner &&
            expiresAt &&
            expiresAt.getTime() > now.getTime()
          ) {
            return { raw: [], affected: 0 }
          }
          Object.assign(operation, state.values)
          return { raw: [operation], affected: 1 }
        }),
      }
      return builder
    }),
  }
  const placementRepository = {
    findOne: vi.fn(async () => placement),
  }
  const storageNodeRepository = {
    findOne: vi.fn(async () => ({ nodeId: TARGET_NODE_ID, state: 'active' })),
  }
  const workspacePlacementService = {
    switchOwner: vi.fn(async () => ({ ...placement, ownerNodeId: TARGET_NODE_ID, fenceEpoch: '4' })),
  }
  const service = new WorkspaceMoveService(
    operationRepository as any,
    placementRepository as any,
    storageNodeRepository as any,
    workspacePlacementService as any,
  )
  return {
    service,
    operations,
    saveSnapshots,
    operationRepository,
    placementRepository,
    claimExecutions,
    storageNodeRepository,
    workspacePlacementService,
  }
}

const request = {
  operationId: OPERATION_ID,
  placementId: PLACEMENT_ID,
  volumeId: VOLUME_ID,
  sandboxId: SANDBOX_ID,
  sourceNodeId: SOURCE_NODE_ID,
  targetNodeId: TARGET_NODE_ID,
  expectedFenceEpoch: '3',
  idempotencyKey: 'move-test-1',
}

describe('WorkspaceMoveService', () => {
  it('creates an idempotent requested operation and keeps target validation in the control plane', async () => {
    const { service } = makeService()
    const first = await service.request(request)
    const second = await service.request(request)
    expect(first).toBe(second)
    expect(first.phase).toBe('requested')
  })

  it('rejects a second active operation for the same placement', async () => {
    const { service } = makeService()
    await service.request(request)

    await expect(
      service.request({
        ...request,
        operationId: '77777777-7777-4777-8777-777777777777',
        idempotencyKey: 'move-test-2',
      }),
    ).rejects.toThrow('move_operation_in_progress')
  })

  it('does not take over an unexpired operation lease owned by another worker', async () => {
    const { service, operations, claimExecutions } = makeService()
    await service.request(request)
    operations[0].leaseOwner = 'move-worker:other'
    operations[0].leaseExpiresAt = new Date(Date.now() + 60_000)

    await expect(
      service.run(OPERATION_ID, {
        quiesce: vi.fn(),
        checkpoint: vi.fn(),
        copy: vi.fn(),
        verifyTarget: vi.fn(),
        startTarget: vi.fn(),
        retainSource: vi.fn(),
      } as any),
    ).rejects.toThrow('move_operation_lease_conflict')
    expect(claimExecutions).toHaveLength(1)
    expect(claimExecutions[0].params.leaseOwner).toMatch(/^move-worker:/)
  })

  it('does not let a second service instance renew the first worker lease', async () => {
    const first = makeService()
    await first.service.request(request)
    const second = new (WorkspaceMoveService as any)(
      first.operationRepository,
      first.placementRepository,
      first.storageNodeRepository,
      first.workspacePlacementService,
    )
    const runtime = {
      quiesce: vi.fn(async () => {
        throw new Error('injected_worker_failure')
      }),
      checkpoint: vi.fn(),
      copy: vi.fn(),
      verifyTarget: vi.fn(),
      startTarget: vi.fn(),
      retainSource: vi.fn(),
    }

    await expect(first.service.run(OPERATION_ID, runtime as any)).rejects.toThrow('move_phase_failed')
    await expect(second.run(OPERATION_ID, runtime as any)).rejects.toThrow('move_operation_lease_conflict')
  })

  it('runs every move phase and switches owner only after target verification', async () => {
    const { service, operations, saveSnapshots, workspacePlacementService } = makeService()
    await service.request(request)
    const events: string[] = []
    workspacePlacementService.switchOwner.mockImplementation(async () => {
      events.push('switch-owner')
      return { ownerNodeId: TARGET_NODE_ID, fenceEpoch: '4' }
    })
    const runtime = {
      quiesce: vi.fn(async () => events.push('quiesce')),
      checkpoint: vi.fn(async () => {
        events.push('checkpoint')
        return { generation: '4' }
      }),
      copy: vi.fn(async () => events.push('copy')),
      verifyTarget: vi.fn(async () => {
        events.push('verify')
        return { generation: '4', manifestHash: 'a'.repeat(64) }
      }),
      startTarget: vi.fn(async () => events.push('start-target')),
      retainSource: vi.fn(async () => events.push('retain-source')),
    }

    const result = await service.run(OPERATION_ID, runtime as any, new Date('2026-08-17T00:00:00.000Z'))

    expect(result.phase).toBe('complete')
    expect(result.sourceRetained).toBe(true)
    expect(result.switchedFenceEpoch).toBe('4')
    expect(result.completedAt).toEqual(new Date('2026-08-17T00:00:00.000Z'))
    expect(saveSnapshots.find((snapshot) => snapshot.phase === 'complete')?.completedAt).toEqual(
      new Date('2026-08-17T00:00:00.000Z'),
    )
    expect(events).toEqual(['quiesce', 'checkpoint', 'copy', 'verify', 'switch-owner', 'start-target', 'retain-source'])
    expect(workspacePlacementService.switchOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        targetVerified: true,
        expectedFenceEpoch: 3,
        expectedLocalGeneration: '3',
        targetGeneration: '4',
        operationId: OPERATION_ID,
        operationLeaseOwner: expect.stringMatching(/^move-worker:/),
      }),
    )
    expect(runtime.checkpoint).toHaveBeenCalledWith(expect.objectContaining({ checkpointGeneration: '4' }))
    expect(events.indexOf('verify')).toBeLessThan(events.indexOf('switch-owner'))
    expect(operations[0].phase).toBe('complete')
  })

  it('resumes from a failed copy phase without repeating quiesce or checkpoint', async () => {
    const { service } = makeService()
    await service.request(request)
    let fail = true
    const runtime = {
      quiesce: vi.fn(),
      checkpoint: vi.fn(async () => ({ generation: '4' })),
      copy: vi.fn(async () => {
        if (fail) {
          fail = false
          throw new Error('copy interruption')
        }
      }),
      verifyTarget: vi.fn(async () => ({ generation: '4', manifestHash: 'a'.repeat(64) })),
      startTarget: vi.fn(),
      retainSource: vi.fn(),
    }
    await expect(service.run(OPERATION_ID, runtime as any)).rejects.toThrow('move_phase_failed')
    await service.run(OPERATION_ID, runtime as any)
    expect(runtime.quiesce).toHaveBeenCalledOnce()
    expect(runtime.checkpoint).toHaveBeenCalledOnce()
    expect(runtime.copy).toHaveBeenCalledTimes(2)
  })

  it('does not switch owner when target verification returns a different generation', async () => {
    const { service, operations, workspacePlacementService } = makeService()
    await service.request(request)
    const runtime = {
      quiesce: vi.fn(),
      checkpoint: vi.fn(async () => ({ generation: '4' })),
      copy: vi.fn(),
      verifyTarget: vi.fn(async () => ({ generation: '5', manifestHash: 'a'.repeat(64) })),
      startTarget: vi.fn(),
      retainSource: vi.fn(),
    }

    await expect(service.run(OPERATION_ID, runtime as any)).rejects.toThrow('move_phase_failed')

    expect(workspacePlacementService.switchOwner).not.toHaveBeenCalled()
    expect(operations[0]).toMatchObject({ phase: 'copying', errorCode: 'move_phase_failed' })
  })

  it('does not switch owner if the target is cordoned after the copy is verified', async () => {
    const { service, storageNodeRepository, workspacePlacementService } = makeService()
    await service.request(request)
    storageNodeRepository.findOne.mockResolvedValue({ nodeId: TARGET_NODE_ID, state: 'cordoned' })
    const runtime = {
      quiesce: vi.fn(),
      checkpoint: vi.fn(async () => ({ generation: '4' })),
      copy: vi.fn(),
      verifyTarget: vi.fn(async () => ({ generation: '4', manifestHash: 'a'.repeat(64) })),
      startTarget: vi.fn(),
      retainSource: vi.fn(),
    }

    await expect(service.run(OPERATION_ID, runtime as any)).rejects.toThrow('move_target_not_schedulable')

    expect(workspacePlacementService.switchOwner).not.toHaveBeenCalled()
  })

  it('persists a fixed Runner start category instead of hiding it as move_phase_failed', async () => {
    const { service, operations } = makeService()
    await service.request(request)
    const runtime = {
      quiesce: vi.fn(),
      checkpoint: vi.fn(async () => ({ generation: '4' })),
      copy: vi.fn(),
      verifyTarget: vi.fn(async () => ({ generation: '4', manifestHash: 'a'.repeat(64) })),
      startTarget: vi.fn(async () => {
        throw new Error('storage_agent_container_start_failed')
      }),
      retainSource: vi.fn(),
    }

    await expect(service.run(OPERATION_ID, runtime as any)).rejects.toThrow('storage_agent_container_start_failed')
    expect(operations[0]).toMatchObject({
      phase: 'owner_switched',
      errorCode: 'storage_agent_container_start_failed',
    })
  })

  it.each([
    ['quiesce', 'leased'],
    ['checkpoint', 'quiescing'],
    ['copy', 'local_checkpointed'],
    ['verifyTarget', 'copying'],
    ['startTarget', 'owner_switched'],
    ['retainSource', 'target_started'],
  ] as const)(
    'resumes after a crash at the %s phase without losing the durable operation',
    async (failedMethod, phase) => {
      const {
        service,
        operations,
        operationRepository,
        placementRepository,
        storageNodeRepository,
        workspacePlacementService,
        claimExecutions,
      } = makeService()
      await service.request(request)
      const firstRunAt = new Date('2026-08-17T00:00:00.000Z')
      const replacementRunAt = new Date(firstRunAt.getTime() + 60_001)
      let fail = true
      const runtime = {
        quiesce: vi.fn(async () => {
          if (failedMethod === 'quiesce' && fail) {
            fail = false
            throw new Error('injected_quiesce_crash')
          }
        }),
        checkpoint: vi.fn(async () => {
          if (failedMethod === 'checkpoint' && fail) {
            fail = false
            throw new Error('injected_checkpoint_crash')
          }
          return { generation: '4' }
        }),
        copy: vi.fn(async () => {
          if (failedMethod === 'copy' && fail) {
            fail = false
            throw new Error('injected_copy_crash')
          }
        }),
        verifyTarget: vi.fn(async () => {
          if (failedMethod === 'verifyTarget' && fail) {
            fail = false
            throw new Error('injected_verify_crash')
          }
          return { generation: '4', manifestHash: 'a'.repeat(64) }
        }),
        startTarget: vi.fn(async () => {
          if (failedMethod === 'startTarget' && fail) {
            fail = false
            throw new Error('injected_start_crash')
          }
        }),
        retainSource: vi.fn(async () => {
          if (failedMethod === 'retainSource' && fail) {
            fail = false
            throw new Error('injected_retain_crash')
          }
        }),
      }

      await expect(service.run(OPERATION_ID, runtime as any, firstRunAt)).rejects.toThrow('move_phase_failed')
      expect(operations[0].phase).toBe(phase)
      const replacementService = new WorkspaceMoveService(
        operationRepository as any,
        placementRepository as any,
        storageNodeRepository as any,
        workspacePlacementService as any,
      )
      await expect(replacementService.run(OPERATION_ID, runtime as any, replacementRunAt)).resolves.toMatchObject({
        phase: 'complete',
      })
      expect(claimExecutions).toHaveLength(2)
      expect(claimExecutions[1].params.now).toEqual(replacementRunAt)
    },
  )
})
