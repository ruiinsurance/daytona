import { describe, expect, it, vi } from 'vitest'
import { StorageNodeController } from './storage-node.controller'
import { StorageNodeRunnerController } from './storage-node-runner.controller'
import { StorageNodeState } from '../enums/storage-node-state.enum'

const RUNNER_ID = '11111111-1111-4111-8111-111111111111'
const NODE_ID = '22222222-2222-4222-8222-222222222222'

function node(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: NODE_ID,
    runnerId: RUNNER_ID,
    state: StorageNodeState.JOINING,
    capacityBytes: '1000',
    usedBytes: '0',
    capacityInodes: '100',
    usedInodes: '0',
    labels: {},
    heartbeatAt: null,
    removedAt: null,
    createdAt: new Date('2026-08-17T00:00:00.000Z'),
    updatedAt: new Date('2026-08-17T00:00:00.000Z'),
    ...overrides,
  }
}

describe('StorageNodeRunnerController', () => {
  it('registers using the authenticated runner identity and never accepts a body runnerId', async () => {
    const service = { register: vi.fn().mockResolvedValue(node()) }
    const controller = new StorageNodeRunnerController(service as any)

    await controller.register({ runnerId: RUNNER_ID } as any, {
      nodeId: NODE_ID,
      capacityBytes: 1000,
      capacityInodes: 100,
      labels: { zone: 'test' },
      runnerId: 'untrusted-body-value',
    } as any)

    expect(service.register).toHaveBeenCalledWith({
      runnerId: RUNNER_ID,
      nodeId: NODE_ID,
      capacityBytes: 1000,
      capacityInodes: 100,
      labels: { zone: 'test' },
    })
  })

  it('binds heartbeat to both the authenticated runner and the path node id', async () => {
    const service = { heartbeat: vi.fn().mockResolvedValue(node({ heartbeatAt: new Date() })) }
    const controller = new StorageNodeRunnerController(service as any)

    await controller.heartbeat({ runnerId: RUNNER_ID } as any, NODE_ID, {
      capacityBytes: 1000,
      usedBytes: 100,
      capacityInodes: 100,
      usedInodes: 10,
    })

    expect(service.heartbeat).toHaveBeenCalledWith({
      runnerId: RUNNER_ID,
      nodeId: NODE_ID,
      capacityBytes: 1000,
      usedBytes: 100,
      capacityInodes: 100,
      usedInodes: 10,
      labels: undefined,
    })
  })
})

describe('StorageNodeController', () => {
  it('requires the runner path identity when reading status and changing lifecycle', async () => {
    const service = {
      findOneForRunnerOrFail: vi.fn().mockResolvedValue(node()),
      transition: vi.fn().mockResolvedValue(node({ state: StorageNodeState.CORDONED })),
    }
    const controller = new StorageNodeController(service as any)

    await controller.getStatus(RUNNER_ID, NODE_ID)
    await controller.cordon(RUNNER_ID, NODE_ID)

    expect(service.findOneForRunnerOrFail).toHaveBeenCalledWith(NODE_ID, RUNNER_ID)
    expect(service.transition).toHaveBeenCalledWith(NODE_ID, StorageNodeState.CORDONED, RUNNER_ID)
  })
})
