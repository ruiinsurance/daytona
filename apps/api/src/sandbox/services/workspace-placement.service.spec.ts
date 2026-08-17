import { describe, expect, it, vi } from 'vitest'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { WorkspacePlacementService } from './workspace-placement.service'

const RUNNER_A = '11111111-1111-4111-8111-111111111111'
const RUNNER_B = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'
const PLACEMENT_ID = '44444444-4444-4444-8444-444444444444'
const NOW = new Date('2026-08-17T00:00:00.000Z')

function placement(overrides: Partial<WorkspacePlacement> = {}): WorkspacePlacement {
  return {
    id: PLACEMENT_ID,
    volumeId: 'vol-1',
    subpath: `sandboxes/${SANDBOX_ID}/workspace`,
    sandboxId: SANDBOX_ID,
    ownerNodeId: RUNNER_A,
    localGeneration: '3',
    cosGeneration: '2',
    fenceEpoch: '3',
    leaseOwner: null,
    leaseExpiresAt: null,
    replicationStatus: 'pending',
    dirty: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

function queryRepository(result: unknown[]) {
  const query = {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ raw: result, affected: result.length }),
  }
  return {
    query,
    repository: {
      findOne: vi.fn(),
      create: vi.fn((value) => value),
      save: vi.fn(async (value) => value),
      createQueryBuilder: vi.fn(() => query),
    } as any,
  }
}

describe('WorkspacePlacementService', () => {
  it('creates a placement on the selected node and keeps an existing identity owner-affine', async () => {
    const { repository } = queryRepository([])
    const chooseNode = vi.fn().mockResolvedValue({ nodeId: RUNNER_A, reason: 'capacity_score' })
    const service = new WorkspacePlacementService(repository, { chooseNode } as any)

    const created = await service.ensurePlacement({
      volumeId: 'vol-1',
      subpath: `sandboxes/${SANDBOX_ID}/workspace`,
      sandboxId: SANDBOX_ID,
      requiredBytes: 100,
      requiredInodes: 10,
      now: NOW,
    })
    expect(created).toMatchObject({ ownerNodeId: RUNNER_A, fenceEpoch: '1', dirty: true })
    expect(chooseNode).toHaveBeenCalledOnce()

    repository.findOne.mockResolvedValueOnce(created)
    await expect(
      service.ensurePlacement({
        volumeId: 'vol-1',
        subpath: `sandboxes/${SANDBOX_ID}/workspace`,
        sandboxId: SANDBOX_ID,
        requiredBytes: 100,
        requiredInodes: 10,
        now: NOW,
      }),
    ).resolves.toBe(created)
    expect(chooseNode).toHaveBeenCalledOnce()
  })

  it('revalidates identity when a concurrent unique insert wins the race', async () => {
    const { repository } = queryRepository([])
    const concurrent = placement({
      sandboxId: RUNNER_B,
      ownerNodeId: RUNNER_B,
    })
    repository.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(concurrent)
    repository.save.mockRejectedValueOnce({ code: '23505' })
    const service = new WorkspacePlacementService(repository, {
      chooseNode: vi.fn().mockResolvedValue({ nodeId: RUNNER_A, reason: 'capacity_score' }),
    } as any)

    await expect(
      service.ensurePlacement({
        volumeId: 'vol-1',
        subpath: `sandboxes/${SANDBOX_ID}/workspace`,
        sandboxId: SANDBOX_ID,
        requiredBytes: 100,
        requiredInodes: 10,
        now: NOW,
      }),
    ).rejects.toThrow('workspace_identity_conflict')
  })

  it('keeps an available placement owner-affine and does not let another runner start it', async () => {
    const { repository } = queryRepository([])
    const chooseNode = vi.fn().mockResolvedValue({ nodeId: RUNNER_A, reason: 'owner_affinity' })
    const service = new WorkspacePlacementService(repository, { chooseNode } as any)

    await expect(
      service.assertStartAllowed({
        placement: placement({ localGeneration: '8', cosGeneration: '7' }),
        nodeId: RUNNER_B,
        now: NOW,
      }),
    ).rejects.toThrow('workspace_owner_affinity_conflict')

    expect(chooseNode).toHaveBeenCalledWith({
      now: NOW,
      requiredBytes: 0,
      requiredInodes: 0,
      ownerNodeId: RUNNER_A,
    })
  })

  it('fails closed with recovery_required when the owner is unavailable and COS is behind local state', async () => {
    const { repository } = queryRepository([])
    const chooseNode = vi.fn().mockRejectedValue(new Error('owner_node_unavailable'))
    const service = new WorkspacePlacementService(repository, { chooseNode } as any)

    await expect(
      service.assertStartAllowed({
        placement: placement({ localGeneration: '8', cosGeneration: '7' }),
        nodeId: RUNNER_B,
        now: NOW,
      }),
    ).rejects.toThrow('recovery_required')
  })

  it('does not mount an unavailable owner as RW even when COS has caught up', async () => {
    const { repository } = queryRepository([])
    const chooseNode = vi.fn().mockRejectedValue(new Error('owner_node_unavailable'))
    const service = new WorkspacePlacementService(repository, { chooseNode } as any)

    await expect(
      service.assertStartAllowed({
        placement: placement({ localGeneration: '8', cosGeneration: '8' }),
        nodeId: RUNNER_B,
        now: NOW,
      }),
    ).rejects.toThrow('owner_node_unavailable')
  })

  it('acquires a writer lease only with the current owner and fence epoch', async () => {
    const current = placement()
    const { repository, query } = queryRepository([current])
    const service = new WorkspacePlacementService(repository, {} as any)

    await expect(
      service.acquireWriterLease({
        placementId: PLACEMENT_ID,
        nodeId: RUNNER_A,
        fenceEpoch: 3,
        leaseOwner: 'runner-a-process',
        now: NOW,
        leaseDurationMs: 30_000,
      }),
    ).resolves.toBe(current)
    expect(query.andWhere).toHaveBeenCalledWith('"ownerNodeId" = :nodeId', { nodeId: RUNNER_A })
    expect(query.andWhere).toHaveBeenCalledWith('"fenceEpoch" = :fenceEpoch', { fenceEpoch: '3' })

    const { repository: conflictRepository } = queryRepository([])
    const conflictService = new WorkspacePlacementService(conflictRepository, {} as any)
    await expect(
      conflictService.acquireWriterLease({
        placementId: PLACEMENT_ID,
        nodeId: RUNNER_A,
        fenceEpoch: 3,
        leaseOwner: 'runner-b-process',
        now: NOW,
      }),
    ).rejects.toThrow('workspace_lease_conflict')
  })

  it('requires a verified target before the owner CAS and increments the fence once', async () => {
    const { repository, query } = queryRepository([placement({ ownerNodeId: RUNNER_B, fenceEpoch: '4' })])
    const service = new WorkspacePlacementService(repository, {} as any)

    await expect(
      service.switchOwner({
        placementId: PLACEMENT_ID,
        expectedOwnerNodeId: RUNNER_A,
        expectedFenceEpoch: 3,
        targetNodeId: RUNNER_B,
        targetVerified: false,
        now: NOW,
      }),
    ).rejects.toThrow('target_not_verified')
    expect(query.execute).not.toHaveBeenCalled()

    await expect(
      service.switchOwner({
        placementId: PLACEMENT_ID,
        expectedOwnerNodeId: RUNNER_A,
        expectedFenceEpoch: 3,
        targetNodeId: RUNNER_B,
        targetVerified: true,
        now: NOW,
      }),
    ).resolves.toMatchObject({ ownerNodeId: RUNNER_B, fenceEpoch: '4' })
    expect(query.set).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerNodeId: RUNNER_B,
        leaseOwner: null,
        leaseExpiresAt: null,
      }),
    )
    expect(query.andWhere).toHaveBeenCalledWith('"ownerNodeId" = :ownerNodeId', { ownerNodeId: RUNNER_A })
    expect(query.andWhere).toHaveBeenCalledWith('"fenceEpoch" = :fenceEpoch', { fenceEpoch: '3' })

    const { repository: staleRepository } = queryRepository([])
    const staleService = new WorkspacePlacementService(staleRepository, {} as any)
    await expect(
      staleService.switchOwner({
        placementId: PLACEMENT_ID,
        expectedOwnerNodeId: RUNNER_A,
        expectedFenceEpoch: 3,
        targetNodeId: RUNNER_B,
        targetVerified: true,
        now: NOW,
      }),
    ).rejects.toThrow('workspace_owner_cas_miss')
  })

  it('releases only the exact placement lease owner and fence', async () => {
    const current = placement({ leaseOwner: 'generation-worker:' + PLACEMENT_ID })
    const { repository, query } = queryRepository([current])
    const service = new WorkspacePlacementService(repository, {} as any)

    await expect(
      service.releaseWriterLease({
        placementId: PLACEMENT_ID,
        nodeId: RUNNER_A,
        fenceEpoch: 3,
        leaseOwner: current.leaseOwner as string,
        now: NOW,
      }),
    ).resolves.toBe(true)
    expect(query.set).toHaveBeenCalledWith({ leaseOwner: null, leaseExpiresAt: null, updatedAt: NOW })
    expect(query.andWhere).toHaveBeenCalledWith('"leaseOwner" = :leaseOwner', { leaseOwner: current.leaseOwner })

    const { repository: staleRepository } = queryRepository([])
    const staleService = new WorkspacePlacementService(staleRepository, {} as any)
    await expect(
      staleService.releaseWriterLease({
        placementId: PLACEMENT_ID,
        nodeId: RUNNER_A,
        fenceEpoch: 3,
        leaseOwner: current.leaseOwner as string,
        now: NOW,
      }),
    ).resolves.toBe(false)
  })

  it('rejects stale or expired writer evidence before admitting writes', () => {
    const service = new WorkspacePlacementService({} as any, {} as any)
    expect(() =>
      service.assertWriterLease(
        placement({
          leaseOwner: 'runner-a-process',
          leaseExpiresAt: new Date(NOW.getTime() - 1),
        }),
        {
          nodeId: RUNNER_A,
          fenceEpoch: 3,
          leaseOwner: 'runner-a-process',
          now: NOW,
        },
      ),
    ).toThrow('workspace_lease_expired')
  })
})
