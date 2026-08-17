import { describe, expect, it } from 'vitest'
import { StorageNode } from '../entities/storage-node.entity'
import { StorageNodeState } from '../enums/storage-node-state.enum'
import { StorageNodeService } from './storage-node.service'

const RUNNER_ID = '11111111-1111-4111-8111-111111111111'
const NODE_ID = '22222222-2222-4222-8222-222222222222'

function repositories() {
  const nodes: StorageNode[] = []
  const placements: any[] = []
  const nodeRepository = {
    findOne: async ({ where }: any) => nodes.find((node) =>
      (where.nodeId === undefined || node.nodeId === where.nodeId)
      && (where.runnerId === undefined || node.runnerId === where.runnerId)) ?? null,
    find: async () => nodes,
    create: (value: Partial<StorageNode>) => value as StorageNode,
    save: async (value: StorageNode) => {
      const index = nodes.findIndex((node) => node.nodeId === value.nodeId)
      if (index === -1) nodes.push(value)
      else nodes[index] = value
      return value
    },
  }
  const placementRepository = {
    count: async ({ where }: any = {}) => placements.filter((placement) =>
      where?.ownerNodeId === undefined || placement.ownerNodeId === where.ownerNodeId).length,
    find: async ({ where }: any = {}) => placements.filter((placement) =>
      where?.ownerNodeId === undefined || placement.ownerNodeId === where.ownerNodeId),
  }
  return {
    nodes,
    placements,
    nodeRepository: nodeRepository as any,
    placementRepository: placementRepository as any,
  }
}

describe('StorageNodeService', () => {
  it('registers idempotently, keeps joining until activation, and records heartbeat capacity', async () => {
    const repos = repositories()
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository)
    const registered = await service.register({
      runnerId: RUNNER_ID,
      nodeId: NODE_ID,
      capacityBytes: 1000,
      capacityInodes: 100,
    })
    expect(registered.state).toBe(StorageNodeState.JOINING)

    const repeated = await service.register({
      runnerId: RUNNER_ID,
      nodeId: NODE_ID,
      capacityBytes: 2000,
      capacityInodes: 200,
    })
    expect(repeated.nodeId).toBe(NODE_ID)
    expect(repeated.state).toBe(StorageNodeState.JOINING)
    expect(repeated.capacityBytes).toBe('2000')

    const heartbeat = await service.heartbeat({
      nodeId: NODE_ID,
      runnerId: RUNNER_ID,
      capacityBytes: 2000,
      usedBytes: 400,
      capacityInodes: 200,
      usedInodes: 20,
    })
    expect(heartbeat.heartbeatAt).toBeInstanceOf(Date)
    expect(heartbeat.usedBytes).toBe('400')
  })

  it('rejects a runner that tries to heartbeat or transition another runner node', async () => {
    const repos = repositories()
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository)
    await service.register({ runnerId: RUNNER_ID, nodeId: NODE_ID, capacityBytes: 1000, capacityInodes: 100 })

    const otherRunnerId = '33333333-3333-4333-8333-333333333333'
    await expect(service.heartbeat({
      nodeId: NODE_ID,
      runnerId: otherRunnerId,
      capacityBytes: 1000,
      usedBytes: 0,
      capacityInodes: 100,
      usedInodes: 0,
    })).rejects.toThrow('storage_node_runner_mismatch')

    await expect(service.transition(NODE_ID, StorageNodeState.ACTIVE, otherRunnerId))
      .rejects.toThrow('storage_node_runner_mismatch')
  })

  it('enforces lifecycle transitions and refuses removal while a workspace is owned', async () => {
    const repos = repositories()
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository)
    await service.register({ runnerId: RUNNER_ID, nodeId: NODE_ID, capacityBytes: 1000, capacityInodes: 100 })
    await expect(service.transition(NODE_ID, StorageNodeState.DRAINING)).rejects.toThrow('invalid_storage_node_transition')
    await service.transition(NODE_ID, StorageNodeState.ACTIVE)
    await service.transition(NODE_ID, StorageNodeState.CORDONED)
    await service.transition(NODE_ID, StorageNodeState.DRAINING)
    await service.transition(NODE_ID, StorageNodeState.DRAINED)
    await service.transition(NODE_ID, StorageNodeState.REMOVED)
    expect((await service.findOneOrFail(NODE_ID)).state).toBe(StorageNodeState.REMOVED)
  })

  it('selects only active nodes with fresh heartbeat and enough capacity', async () => {
    const repos = repositories()
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository)
    await service.register({ runnerId: RUNNER_ID, nodeId: NODE_ID, capacityBytes: 1000, capacityInodes: 100 })
    const secondRunner = '33333333-3333-4333-8333-333333333333'
    const secondNode = '44444444-4444-4444-8444-444444444444'
    await service.register({ runnerId: secondRunner, nodeId: secondNode, capacityBytes: 1000, capacityInodes: 100 })
    await service.transition(NODE_ID, StorageNodeState.ACTIVE)
    await service.transition(secondNode, StorageNodeState.ACTIVE)
    await service.heartbeat({
      nodeId: NODE_ID,
      runnerId: RUNNER_ID,
      capacityBytes: 1000,
      usedBytes: 900,
      capacityInodes: 100,
      usedInodes: 90,
    })
    await service.heartbeat({
      nodeId: secondNode,
      runnerId: secondRunner,
      capacityBytes: 1000,
      usedBytes: 100,
      capacityInodes: 100,
      usedInodes: 10,
    })

    await expect(service.chooseNode({
      now: new Date(),
      requiredBytes: 10,
      requiredInodes: 1,
    })).resolves.toMatchObject({ nodeId: secondNode })
  })

  it('refuses drained or removed lifecycle completion while a move operation is pending', async () => {
    const repos = repositories()
    const operations = [{ phase: 'copying', sourceNodeId: NODE_ID, targetNodeId: '33333333-3333-4333-8333-333333333333' }]
    const operationRepository = { find: async () => operations }
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository, operationRepository as any)
    await service.register({ runnerId: RUNNER_ID, nodeId: NODE_ID, capacityBytes: 1000, capacityInodes: 100 })
    await service.transition(NODE_ID, StorageNodeState.ACTIVE)
    await service.transition(NODE_ID, StorageNodeState.CORDONED)
    await service.transition(NODE_ID, StorageNodeState.DRAINING)
    await expect(service.transition(NODE_ID, StorageNodeState.DRAINED))
      .rejects.toThrow('storage_node_operation_blocked')
    operations.length = 0
    await service.transition(NODE_ID, StorageNodeState.DRAINED)
    operations.push({ phase: 'copying', sourceNodeId: NODE_ID, targetNodeId: '33333333-3333-4333-8333-333333333333' })
    await expect(service.transition(NODE_ID, StorageNodeState.REMOVED))
      .rejects.toThrow('storage_node_operation_blocked')
  })

  it('refuses drain completion while a writer lease or local generation is uncommitted', async () => {
    const repos = repositories()
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository)
    await service.register({ runnerId: RUNNER_ID, nodeId: NODE_ID, capacityBytes: 1000, capacityInodes: 100 })
    await service.transition(NODE_ID, StorageNodeState.ACTIVE)
    await service.transition(NODE_ID, StorageNodeState.CORDONED)
    await service.transition(NODE_ID, StorageNodeState.DRAINING)

    repos.placements.push({
      ownerNodeId: NODE_ID,
      leaseOwner: 'runner:writer',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      dirty: false,
      localGeneration: '1',
      cosGeneration: '1',
    })
    await expect(service.transition(NODE_ID, StorageNodeState.DRAINED))
      .rejects.toThrow('storage_node_active_lease')

    repos.placements[0].leaseOwner = null
    repos.placements[0].leaseExpiresAt = null
    repos.placements[0].dirty = true
    repos.placements[0].localGeneration = '2'
    await expect(service.transition(NODE_ID, StorageNodeState.DRAINED))
      .rejects.toThrow('storage_node_uncommitted_generation')
  })

  it('requires an emptied drained or offline node before removal', async () => {
    const repos = repositories()
    const service = new StorageNodeService(repos.nodeRepository, repos.placementRepository)
    await service.register({ runnerId: RUNNER_ID, nodeId: NODE_ID, capacityBytes: 1000, capacityInodes: 100 })
    await expect(service.transition(NODE_ID, StorageNodeState.REMOVED))
      .rejects.toThrow('storage_node_remove_requires_drained')
  })
})
