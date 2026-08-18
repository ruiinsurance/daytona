import { describe, expect, it, vi } from 'vitest'
import { WorkspaceGenerationService } from './workspace-generation.service'

const PLACEMENT_ID = '11111111-1111-4111-8111-111111111111'
const VOLUME_ID = '22222222-2222-4222-8222-222222222222'
const SANDBOX_ID = '33333333-3333-4333-8333-333333333333'
const NODE_ID = '44444444-4444-4444-8444-444444444444'

function makePlacement() {
  return {
    id: PLACEMENT_ID,
    volumeId: VOLUME_ID,
    subpath: `sandboxes/${SANDBOX_ID}/workspace`,
    sandboxId: SANDBOX_ID,
    ownerNodeId: NODE_ID,
    localGeneration: '3',
    cosGeneration: '2',
    fenceEpoch: '9',
    leaseOwner: 'writer:current',
    leaseExpiresAt: new Date('2026-08-19T12:05:00.000Z'),
    replicationStatus: 'committed',
    dirty: false,
  }
}

function setup() {
  const current = makePlacement()
  const query = {
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    andWhere: vi.fn().mockReturnThis(),
    returning: vi.fn().mockReturnThis(),
    setParameter: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue({ raw: [current], affected: 1 }),
  }
  const placementRepository = {
    findOne: vi.fn().mockResolvedValue(current),
    createQueryBuilder: vi.fn().mockReturnValue(query),
    save: vi.fn(),
  }
  const service = new WorkspaceGenerationService({} as any, placementRepository as any, {} as any)
  return { current, query, placementRepository, service }
}

describe('WorkspaceGenerationService dirty event update', () => {
  it('marks dirty with an atomic field update and preserves the active writer tuple', async () => {
    const { current, query, placementRepository, service } = setup()

    await service.markDirty({ placementId: PLACEMENT_ID, localGeneration: '4' })

    expect(query.update).toHaveBeenCalledOnce()
    expect(query.set).toHaveBeenCalledOnce()
    const update = query.set.mock.calls[0][0]
    expect(update).toEqual(
      expect.objectContaining({
        dirty: true,
        replicationStatus: expect.any(Function),
        localGeneration: expect.any(Function),
      }),
    )
    expect(update).not.toHaveProperty('ownerNodeId')
    expect(update).not.toHaveProperty('fenceEpoch')
    expect(update).not.toHaveProperty('leaseOwner')
    expect(update).not.toHaveProperty('leaseExpiresAt')
    expect(update.localGeneration()).toContain('GREATEST')
    expect(query.setParameter).toHaveBeenCalledWith('incomingGeneration', '4')
    expect(placementRepository.save).not.toHaveBeenCalled()
    expect(current.leaseOwner).toBe('writer:current')
    expect(current.fenceEpoch).toBe('9')
  })

  it('resolves a dirty event by canonical workspace identity and owner node', async () => {
    const { query, placementRepository, service } = setup()

    await service.markDirtyByIdentity({
      volumeId: VOLUME_ID,
      sandboxId: SANDBOX_ID,
      ownerNodeId: NODE_ID,
    })

    expect(placementRepository.findOne).toHaveBeenCalledWith({
      where: { volumeId: VOLUME_ID, sandboxId: SANDBOX_ID },
    })
    expect(query.where).toHaveBeenCalledWith('id = :placementId', { placementId: PLACEMENT_ID })
    expect(query.andWhere).toHaveBeenCalledWith('"ownerNodeId" = :ownerNodeId', { ownerNodeId: NODE_ID })
  })
})
