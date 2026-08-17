export type StorageNodeState =
  | 'joining'
  | 'active'
  | 'cordoned'
  | 'draining'
  | 'drained'
  | 'offline'
  | 'removed'

export const LOCAL_FIRST_STORAGE_BACKEND = 'local-first'

export interface StorageNodeCandidate {
  nodeId: string
  state: StorageNodeState
  heartbeatAt: Date | null
  capacityBytes: number
  usedBytes: number
  capacityInodes: number
  usedInodes: number
}

export interface StorageNodeSelectionOptions {
  now: Date
  requiredBytes: number
  requiredInodes: number
  ownerNodeId?: string
  heartbeatTtlMs?: number
}

export interface StorageNodeSelection {
  nodeId: string
  reason: 'owner_affinity' | 'capacity_score'
}

const TRANSITIONS: Record<StorageNodeState, readonly StorageNodeState[]> = {
  joining: ['joining', 'active', 'offline', 'removed'],
  active: ['active', 'cordoned', 'offline'],
  cordoned: ['cordoned', 'active', 'draining', 'offline'],
  draining: ['draining', 'drained', 'offline'],
  drained: ['drained', 'active', 'removed', 'offline'],
  offline: ['offline', 'active', 'removed'],
  removed: ['removed'],
}

export function transitionStorageNodeState(
  current: StorageNodeState,
  next: StorageNodeState,
): StorageNodeState {
  if (!TRANSITIONS[current].includes(next)) {
    throw new Error('invalid_storage_node_transition')
  }
  return next
}

export function chooseStorageNode(
  nodes: readonly StorageNodeCandidate[],
  options: StorageNodeSelectionOptions,
): StorageNodeSelection {
  assertNonNegativeFinite(options.requiredBytes, 'required_bytes_invalid')
  assertNonNegativeFinite(options.requiredInodes, 'required_inodes_invalid')
  const heartbeatTtlMs = options.heartbeatTtlMs ?? 60_000

  if (options.ownerNodeId) {
    const owner = nodes.find((node) => node.nodeId === options.ownerNodeId)
    if (
      owner
      && owner.state !== 'removed'
      && owner.state !== 'offline'
      && owner.heartbeatAt !== null
      && options.now.getTime() - owner.heartbeatAt.getTime() <= heartbeatTtlMs
    ) {
      return { nodeId: owner.nodeId, reason: 'owner_affinity' }
    }
    throw new Error('owner_node_unavailable')
  }

  const candidates = nodes
    .filter((node) => node.state === 'active')
    .filter((node) => node.heartbeatAt !== null
      && options.now.getTime() - node.heartbeatAt.getTime() <= heartbeatTtlMs)
    .filter((node) => node.capacityBytes - node.usedBytes >= options.requiredBytes)
    .filter((node) => node.capacityInodes - node.usedInodes >= options.requiredInodes)
    .map((node) => ({
      node,
      score: capacityScore(node),
    }))
    .sort((left, right) => right.score - left.score || left.node.nodeId.localeCompare(right.node.nodeId))

  if (candidates.length === 0) {
    throw new Error('no_schedulable_storage_node')
  }
  return { nodeId: candidates[0].node.nodeId, reason: 'capacity_score' }
}

export interface WorkspaceFence {
  ownerNodeId: string
  fenceEpoch: number
  leaseExpiresAt: Date
}

export function assertWorkspaceFence(
  placement: WorkspaceFence,
  request: { nodeId: string; fenceEpoch: number; now: Date },
): void {
  if (placement.leaseExpiresAt.getTime() <= request.now.getTime()) {
    throw new Error('workspace_lease_expired')
  }
  if (placement.ownerNodeId !== request.nodeId || placement.fenceEpoch !== request.fenceEpoch) {
    throw new Error('stale_workspace_fence')
  }
}

export function switchWorkspaceOwner(
  placement: Pick<WorkspaceFence, 'ownerNodeId' | 'fenceEpoch'>,
  input: {
    expectedOwnerNodeId: string
    expectedFenceEpoch: number
    targetNodeId: string
    targetVerified: boolean
  },
): Pick<WorkspaceFence, 'ownerNodeId' | 'fenceEpoch'> {
  if (!input.targetVerified) throw new Error('target_not_verified')
  if (
    placement.ownerNodeId !== input.expectedOwnerNodeId
    || placement.fenceEpoch !== input.expectedFenceEpoch
  ) {
    throw new Error('workspace_owner_cas_miss')
  }
  if (placement.ownerNodeId === input.targetNodeId) {
    return placement
  }
  if (!Number.isSafeInteger(placement.fenceEpoch) || placement.fenceEpoch >= Number.MAX_SAFE_INTEGER) {
    throw new Error('workspace_fence_exhausted')
  }
  return {
    ownerNodeId: input.targetNodeId,
    fenceEpoch: placement.fenceEpoch + 1,
  }
}

function capacityScore(node: StorageNodeCandidate): number {
  const bytesRatio = ratio(node.capacityBytes - node.usedBytes, node.capacityBytes)
  const inodeRatio = ratio(node.capacityInodes - node.usedInodes, node.capacityInodes)
  return bytesRatio + inodeRatio
}

function ratio(available: number, capacity: number): number {
  if (!Number.isFinite(available) || !Number.isFinite(capacity) || capacity <= 0) return 0
  return Math.max(0, available / capacity)
}

function assertNonNegativeFinite(value: number, code: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(code)
}
