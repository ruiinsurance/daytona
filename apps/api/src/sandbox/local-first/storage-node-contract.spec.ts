import { describe, expect, it } from 'vitest'
import {
  assertWorkspaceFence,
  chooseStorageNode,
  switchWorkspaceOwner,
  transitionStorageNodeState,
  type StorageNodeCandidate,
} from './storage-node-contract'

const NOW = new Date('2026-08-17T00:00:00.000Z')

function candidate(overrides: Partial<StorageNodeCandidate> = {}): StorageNodeCandidate {
  return {
    nodeId: 'node-a',
    state: 'active',
    heartbeatAt: NOW,
    capacityBytes: 1000,
    usedBytes: 100,
    capacityInodes: 1000,
    usedInodes: 100,
    ...overrides,
  }
}

describe('local-first storage node contract', () => {
  it('allows only explicit lifecycle transitions and keeps retries idempotent', () => {
    expect(transitionStorageNodeState('joining', 'active')).toBe('active')
    expect(transitionStorageNodeState('active', 'active')).toBe('active')
    expect(transitionStorageNodeState('active', 'cordoned')).toBe('cordoned')
    expect(transitionStorageNodeState('cordoned', 'draining')).toBe('draining')
    expect(transitionStorageNodeState('draining', 'drained')).toBe('drained')
    expect(transitionStorageNodeState('drained', 'removed')).toBe('removed')
    expect(() => transitionStorageNodeState('removed', 'active')).toThrow('invalid_storage_node_transition')
    expect(() => transitionStorageNodeState('joining', 'draining')).toThrow('invalid_storage_node_transition')
  })

  it('keeps an existing owner and deterministically selects the best new node', () => {
    const nodes = [
      candidate({ nodeId: 'node-b', usedBytes: 100 }),
      candidate({ nodeId: 'node-a', usedBytes: 100 }),
      candidate({ nodeId: 'node-c', state: 'cordoned' }),
    ]
    expect(chooseStorageNode(nodes, { now: NOW, requiredBytes: 10, requiredInodes: 1 })).toMatchObject({
      nodeId: 'node-a',
      reason: 'capacity_score',
    })
    expect(chooseStorageNode(nodes, {
      now: NOW,
      requiredBytes: 10,
      requiredInodes: 1,
      ownerNodeId: 'node-b',
    })).toMatchObject({ nodeId: 'node-b', reason: 'owner_affinity' })
  })

  it('fails closed for stale heartbeat, cordoned nodes, expired leases, and old fences', () => {
    expect(() => chooseStorageNode([
      candidate({ heartbeatAt: new Date(NOW.getTime() - 61_000) }),
    ], { now: NOW, heartbeatTtlMs: 60_000, requiredBytes: 1, requiredInodes: 1 }))
      .toThrow('no_schedulable_storage_node')

    expect(() => assertWorkspaceFence({
      ownerNodeId: 'node-a',
      fenceEpoch: 7,
      leaseExpiresAt: new Date(NOW.getTime() - 1),
    }, { nodeId: 'node-a', fenceEpoch: 7, now: NOW })).toThrow('workspace_lease_expired')

    expect(() => assertWorkspaceFence({
      ownerNodeId: 'node-a',
      fenceEpoch: 7,
      leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    }, { nodeId: 'node-b', fenceEpoch: 7, now: NOW })).toThrow('stale_workspace_fence')

    expect(() => chooseStorageNode([
      candidate({ state: 'offline' }),
    ], { now: NOW, requiredBytes: 1, requiredInodes: 1, ownerNodeId: 'node-a' }))
      .toThrow('owner_node_unavailable')

    expect(() => chooseStorageNode([
      candidate({ heartbeatAt: new Date(NOW.getTime() - 61_000) }),
    ], { now: NOW, heartbeatTtlMs: 60_000, requiredBytes: 1, requiredInodes: 1, ownerNodeId: 'node-a' }))
      .toThrow('owner_node_unavailable')
  })

  it('does not switch owner or increment fence before target verification', () => {
    expect(() => switchWorkspaceOwner({
      ownerNodeId: 'node-a',
      fenceEpoch: 3,
    }, {
      expectedOwnerNodeId: 'node-a',
      expectedFenceEpoch: 3,
      targetNodeId: 'node-b',
      targetVerified: false,
    })).toThrow('target_not_verified')

    expect(switchWorkspaceOwner({ ownerNodeId: 'node-a', fenceEpoch: 3 }, {
      expectedOwnerNodeId: 'node-a',
      expectedFenceEpoch: 3,
      targetNodeId: 'node-b',
      targetVerified: true,
    })).toEqual({ ownerNodeId: 'node-b', fenceEpoch: 4 })
  })
})
