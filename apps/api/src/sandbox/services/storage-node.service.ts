import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { StorageNode } from '../entities/storage-node.entity'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import {
  chooseStorageNode,
  transitionStorageNodeState,
  type StorageNodeCandidate,
} from '../local-first/storage-node-contract'
import { StorageNodeState } from '../enums/storage-node-state.enum'
import { WorkspaceOperation } from '../entities/workspace-operation.entity'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface RegisterStorageNodeInput {
  runnerId: string
  nodeId: string
  capacityBytes?: number
  capacityInodes?: number
  labels?: Record<string, string>
}

export interface HeartbeatStorageNodeInput {
  nodeId: string
  runnerId: string
  capacityBytes: number
  usedBytes: number
  capacityInodes: number
  usedInodes: number
  labels?: Record<string, string>
  heartbeatAt?: Date
}

@Injectable()
export class StorageNodeService {
  constructor(
    @InjectRepository(StorageNode)
    private readonly storageNodeRepository: Repository<StorageNode>,
    @InjectRepository(WorkspacePlacement)
    private readonly placementRepository: Repository<WorkspacePlacement>,
    @Optional()
    @InjectRepository(WorkspaceOperation)
    private readonly operationRepository?: Repository<WorkspaceOperation>,
  ) {}

  async register(input: RegisterStorageNodeInput): Promise<StorageNode> {
    assertUuid(input.runnerId, 'runner_id_invalid')
    assertUuid(input.nodeId, 'node_id_invalid')
    const capacityBytes = nonNegative(input.capacityBytes ?? 0, 'capacity_bytes_invalid')
    const capacityInodes = nonNegative(input.capacityInodes ?? 0, 'capacity_inodes_invalid')
    const existing = await this.storageNodeRepository.findOne({ where: { nodeId: input.nodeId } })
    if (existing) {
      if (existing.runnerId !== input.runnerId) throw new ConflictException('storage_node_identity_conflict')
      if (existing.state === StorageNodeState.REMOVED) throw new ConflictException('storage_node_removed')
      existing.capacityBytes = String(capacityBytes)
      existing.capacityInodes = String(capacityInodes)
      existing.labels = input.labels ?? existing.labels ?? {}
      return this.storageNodeRepository.save(existing)
    }

    const runnerNode = await this.storageNodeRepository.findOne({ where: { runnerId: input.runnerId } })
    if (runnerNode) throw new ConflictException('runner_storage_node_conflict')

    const node = this.storageNodeRepository.create({
      nodeId: input.nodeId,
      runnerId: input.runnerId,
      state: StorageNodeState.JOINING,
      capacityBytes: String(capacityBytes),
      usedBytes: '0',
      capacityInodes: String(capacityInodes),
      usedInodes: '0',
      labels: input.labels ?? {},
      heartbeatAt: null,
      removedAt: null,
    })
    return this.storageNodeRepository.save(node)
  }

  async heartbeat(input: HeartbeatStorageNodeInput): Promise<StorageNode> {
    assertUuid(input.nodeId, 'node_id_invalid')
    assertUuid(input.runnerId, 'runner_id_invalid')
    const node = await this.findOneOrFail(input.nodeId)
    if (node.state === StorageNodeState.REMOVED) throw new ConflictException('storage_node_removed')
    assertNodeRunner(node, input.runnerId)
    node.capacityBytes = String(nonNegative(input.capacityBytes, 'capacity_bytes_invalid'))
    node.usedBytes = String(nonNegative(input.usedBytes, 'used_bytes_invalid'))
    node.capacityInodes = String(nonNegative(input.capacityInodes, 'capacity_inodes_invalid'))
    node.usedInodes = String(nonNegative(input.usedInodes, 'used_inodes_invalid'))
    node.labels = input.labels ?? node.labels ?? {}
    node.heartbeatAt = input.heartbeatAt ?? new Date()
    return this.storageNodeRepository.save(node)
  }

  async findOneOrFail(nodeId: string): Promise<StorageNode> {
    assertUuid(nodeId, 'node_id_invalid')
    const node = await this.storageNodeRepository.findOne({ where: { nodeId } })
    if (!node) throw new NotFoundException('Storage node not found')
    return node
  }

  async findByRunnerId(runnerId: string): Promise<StorageNode | null> {
    assertUuid(runnerId, 'runner_id_invalid')
    return this.storageNodeRepository.findOne({ where: { runnerId } })
  }

  async findOneForRunnerOrFail(nodeId: string, runnerId: string): Promise<StorageNode> {
    assertUuid(runnerId, 'runner_id_invalid')
    const node = await this.findOneOrFail(nodeId)
    assertNodeRunner(node, runnerId)
    return node
  }

  async transition(nodeId: string, nextState: StorageNodeState, expectedRunnerId?: string): Promise<StorageNode> {
    if (expectedRunnerId) assertUuid(expectedRunnerId, 'runner_id_invalid')
    const node = await this.findOneOrFail(nodeId)
    if (expectedRunnerId) assertNodeRunner(node, expectedRunnerId)
    try {
      transitionStorageNodeState(node.state, nextState)
    } catch {
      throw new BadRequestException('invalid_storage_node_transition')
    }
    if (
      nextState === StorageNodeState.REMOVED
      && node.state !== StorageNodeState.DRAINED
      && node.state !== StorageNodeState.OFFLINE
    ) {
      throw new ConflictException('storage_node_remove_requires_drained')
    }
    if (nextState === StorageNodeState.DRAINED || nextState === StorageNodeState.REMOVED) {
      const ownedPlacements = await this.placementRepository.find({ where: { ownerNodeId: node.nodeId } })
      const now = new Date()
      for (const placement of ownedPlacements) {
        if (
          placement.leaseOwner
          && (!placement.leaseExpiresAt || placement.leaseExpiresAt.getTime() > now.getTime())
        ) {
          throw new ConflictException('storage_node_active_lease')
        }
        if (placement.dirty || isGenerationAhead(placement.localGeneration, placement.cosGeneration)) {
          throw new ConflictException('storage_node_uncommitted_generation')
        }
      }
      const ownedCount = await this.placementRepository.count({ where: { ownerNodeId: node.nodeId } })
      if (ownedCount > 0) {
        throw new ConflictException(nextState === StorageNodeState.REMOVED
          ? 'storage_node_remove_blocked'
          : 'storage_node_drain_incomplete')
      }
      if (this.operationRepository) {
        const operations = await this.operationRepository.find()
        const pending = operations.some((operation) =>
          operation.phase !== 'complete'
          && (operation.sourceNodeId === node.nodeId || operation.targetNodeId === node.nodeId),
        )
        if (pending) throw new ConflictException('storage_node_operation_blocked')
      }
      if (nextState === StorageNodeState.REMOVED) node.removedAt = new Date()
    }
    node.state = nextState
    return this.storageNodeRepository.save(node)
  }

  async chooseNode(input: {
    now: Date
    requiredBytes: number
    requiredInodes: number
    ownerNodeId?: string
    heartbeatTtlMs?: number
  }): Promise<{ nodeId: string; reason: 'owner_affinity' | 'capacity_score' }> {
    const nodes = await this.storageNodeRepository.find()
    const candidates: StorageNodeCandidate[] = nodes.map((node) => ({
      nodeId: node.nodeId,
      state: node.state,
      heartbeatAt: node.heartbeatAt,
      capacityBytes: Number(node.capacityBytes),
      usedBytes: Number(node.usedBytes),
      capacityInodes: Number(node.capacityInodes),
      usedInodes: Number(node.usedInodes),
    }))
    return chooseStorageNode(candidates, input)
  }
}

function isGenerationAhead(localGeneration: string, cosGeneration: string): boolean {
  try {
    return BigInt(localGeneration || '0') > BigInt(cosGeneration || '0')
  } catch {
    throw new ConflictException('storage_node_generation_invalid')
  }
}

function assertUuid(value: string, code: string): void {
  if (!UUID_RE.test(value)) throw new BadRequestException(code)
}

function nonNegative(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new BadRequestException(code)
  return value
}

function assertNodeRunner(node: StorageNode, runnerId: string): void {
  if (node.runnerId !== runnerId) throw new ConflictException('storage_node_runner_mismatch')
}
