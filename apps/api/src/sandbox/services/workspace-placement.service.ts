import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { StorageNodeService } from './storage-node.service'
import { assertWorkspaceFence } from '../local-first/storage-node-contract'
import { chooseRecoverySource } from '../local-first/workspace-generation.contract'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const VOLUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/

@Injectable()
export class WorkspacePlacementService {
  constructor(
    @InjectRepository(WorkspacePlacement)
    private readonly placementRepository: Repository<WorkspacePlacement>,
    private readonly storageNodeService: StorageNodeService,
  ) {}

  async ensurePlacement(input: {
    volumeId: string
    subpath: string
    sandboxId: string
    requiredBytes: number
    requiredInodes: number
    ownerNodeId?: string
    now?: Date
  }): Promise<WorkspacePlacement> {
    assertWorkspaceIdentity(input.volumeId, input.subpath, input.sandboxId)
    if (input.ownerNodeId) assertUuid(input.ownerNodeId, 'owner_node_id_invalid')
    const existing = await this.placementRepository.findOne({
      where: { volumeId: input.volumeId, subpath: input.subpath },
    })
    if (existing) {
      if (existing.sandboxId !== input.sandboxId) throw new ConflictException('workspace_identity_conflict')
      if (input.ownerNodeId && existing.ownerNodeId !== input.ownerNodeId) {
        throw new ConflictException('workspace_owner_affinity_conflict')
      }
      return existing
    }

    const target = await this.storageNodeService.chooseNode({
      now: input.now ?? new Date(),
      requiredBytes: input.requiredBytes,
      requiredInodes: input.requiredInodes,
      ownerNodeId: input.ownerNodeId,
    })
    const placement = this.placementRepository.create({
      volumeId: input.volumeId,
      subpath: input.subpath,
      sandboxId: input.sandboxId,
      ownerNodeId: target.nodeId,
      localGeneration: '0',
      cosGeneration: '0',
      fenceEpoch: '1',
      leaseOwner: null,
      leaseExpiresAt: null,
      replicationStatus: 'pending',
      dirty: true,
    })
    try {
      return await this.placementRepository.save(placement)
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.placementRepository.findOne({
          where: { volumeId: input.volumeId, subpath: input.subpath },
        })
        if (concurrent) {
          if (concurrent.sandboxId !== input.sandboxId) {
            throw new ConflictException('workspace_identity_conflict')
          }
          if (input.ownerNodeId && concurrent.ownerNodeId !== input.ownerNodeId) {
            throw new ConflictException('workspace_owner_affinity_conflict')
          }
          return concurrent
        }
      }
      throw error
    }
  }

  async findByIdentity(volumeId: string, subpath: string): Promise<WorkspacePlacement> {
    const placement = await this.placementRepository.findOne({ where: { volumeId, subpath } })
    if (!placement) throw new NotFoundException('Workspace placement not found')
    return placement
  }

  async findBySandboxId(sandboxId: string): Promise<WorkspacePlacement | null> {
    assertUuid(sandboxId, 'sandbox_id_invalid')
    return this.placementRepository.findOne({ where: { sandboxId } })
  }

  async assertStartAllowed(input: { placement: WorkspacePlacement; nodeId: string; now?: Date }): Promise<void> {
    assertUuid(input.nodeId, 'node_id_invalid')
    const ownerNodeId = input.placement.ownerNodeId
    if (!ownerNodeId) throw new ConflictException('recovery_required')
    assertUuid(ownerNodeId, 'owner_node_id_invalid')

    const now = input.now ?? new Date()
    let ownerAvailable = true
    try {
      // Reuse the scheduler's owner-affinity health policy for existing placements.
      await this.storageNodeService.chooseNode({
        now,
        requiredBytes: 0,
        requiredInodes: 0,
        ownerNodeId,
      })
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'owner_node_unavailable') throw error
      ownerAvailable = false
    }

    const recoverySource = chooseRecoverySource({
      ownerAvailable,
      localGeneration: input.placement.localGeneration,
      cosGeneration: input.placement.cosGeneration,
      // cosGeneration is advanced only after an immutable generation is committed.
      latestCommittedGeneration: input.placement.cosGeneration,
    })
    if (recoverySource === 'recovery_required') throw new ConflictException('recovery_required')
    if (!ownerAvailable) throw new ConflictException('owner_node_unavailable')
    if (ownerNodeId !== input.nodeId) throw new ConflictException('workspace_owner_affinity_conflict')
  }

  async acquireWriterLease(input: {
    placementId: string
    nodeId: string
    fenceEpoch: number
    leaseOwner: string
    now?: Date
    leaseDurationMs?: number
  }): Promise<WorkspacePlacement> {
    assertUuid(input.placementId, 'placement_id_invalid')
    assertUuid(input.nodeId, 'node_id_invalid')
    assertLeaseOwner(input.leaseOwner)
    const now = input.now ?? new Date()
    const durationMs = input.leaseDurationMs ?? 30_000
    if (
      !Number.isSafeInteger(input.fenceEpoch) ||
      input.fenceEpoch < 0 ||
      durationMs <= 0 ||
      durationMs > 10 * 60 * 1000
    ) {
      throw new BadRequestException('workspace_lease_input_invalid')
    }

    const result = await this.placementRepository
      .createQueryBuilder()
      .update(WorkspacePlacement)
      .set({
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: new Date(now.getTime() + durationMs),
        updatedAt: now,
      })
      .where('id = :placementId', { placementId: input.placementId })
      .andWhere('"ownerNodeId" = :nodeId', { nodeId: input.nodeId })
      .andWhere('"fenceEpoch" = :fenceEpoch', { fenceEpoch: String(input.fenceEpoch) })
      .andWhere('("leaseOwner" IS NULL OR "leaseExpiresAt" <= :now OR "leaseOwner" = :leaseOwner)', {
        now,
        leaseOwner: input.leaseOwner,
      })
      .returning('*')
      .execute()
    const row = result.raw?.[0] as WorkspacePlacement | undefined
    if (!row) throw new ConflictException('workspace_lease_conflict')
    return row
  }

  async releaseWriterLease(input: {
    placementId: string
    nodeId: string
    fenceEpoch: number
    leaseOwner: string
    now?: Date
  }): Promise<boolean> {
    assertUuid(input.placementId, 'placement_id_invalid')
    assertUuid(input.nodeId, 'node_id_invalid')
    assertLeaseOwner(input.leaseOwner)
    if (!Number.isSafeInteger(input.fenceEpoch) || input.fenceEpoch < 0) {
      throw new BadRequestException('workspace_fence_invalid')
    }
    const now = input.now ?? new Date()
    const result = await this.placementRepository
      .createQueryBuilder()
      .update(WorkspacePlacement)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where('id = :placementId', { placementId: input.placementId })
      .andWhere('"ownerNodeId" = :nodeId', { nodeId: input.nodeId })
      .andWhere('"fenceEpoch" = :fenceEpoch', { fenceEpoch: String(input.fenceEpoch) })
      .andWhere('"leaseOwner" = :leaseOwner', { leaseOwner: input.leaseOwner })
      .execute()
    return (result.affected ?? result.raw?.length ?? 0) === 1
  }

  assertWriterLease(
    placement: WorkspacePlacement,
    input: { nodeId: string; fenceEpoch: number; leaseOwner: string; now?: Date },
  ): void {
    if (placement.leaseOwner !== input.leaseOwner) throw new ConflictException('workspace_lease_owner_conflict')
    assertWorkspaceFence(
      {
        ownerNodeId: placement.ownerNodeId ?? '',
        fenceEpoch: Number(placement.fenceEpoch),
        leaseExpiresAt: placement.leaseExpiresAt ?? new Date(0),
      },
      {
        nodeId: input.nodeId,
        fenceEpoch: input.fenceEpoch,
        now: input.now ?? new Date(),
      },
    )
  }

  async switchOwner(input: {
    placementId: string
    sandboxId?: string
    expectedOwnerNodeId: string
    expectedRunnerId?: string
    expectedFenceEpoch: number
    expectedLocalGeneration: string
    operationId: string
    operationLeaseOwner: string
    targetNodeId: string
    targetRunnerId?: string
    targetGeneration: string
    targetVerified: boolean
    now?: Date
  }): Promise<WorkspacePlacement> {
    assertUuid(input.placementId, 'placement_id_invalid')
    assertUuid(input.expectedOwnerNodeId, 'owner_node_id_invalid')
    assertUuid(input.operationId, 'operation_id_invalid')
    assertLeaseOwner(input.operationLeaseOwner)
    assertUuid(input.targetNodeId, 'target_node_id_invalid')
    if (!input.targetVerified) throw new ConflictException('target_not_verified')
    if (!Number.isSafeInteger(input.expectedFenceEpoch) || input.expectedFenceEpoch < 0) {
      throw new BadRequestException('workspace_fence_invalid')
    }
    if (
      !DECIMAL_RE.test(input.expectedLocalGeneration) ||
      !DECIMAL_RE.test(input.targetGeneration) ||
      BigInt(input.targetGeneration) <= BigInt(input.expectedLocalGeneration)
    ) {
      throw new ConflictException('workspace_generation_conflict')
    }
    if (input.sandboxId || input.expectedRunnerId || input.targetRunnerId) {
      if (!input.sandboxId || !input.expectedRunnerId || !input.targetRunnerId) {
        throw new BadRequestException('workspace_runner_assignment_invalid')
      }
      return this.switchOwnerAndRunner(
        input as {
          placementId: string
          sandboxId: string
          expectedOwnerNodeId: string
          expectedRunnerId: string
          expectedFenceEpoch: number
          expectedLocalGeneration: string
          operationId: string
          operationLeaseOwner: string
          targetNodeId: string
          targetRunnerId: string
          targetGeneration: string
          targetVerified: boolean
          now?: Date
        },
      )
    }
    const now = input.now ?? new Date()
    const result = await this.placementRepository
      .createQueryBuilder()
      .update(WorkspacePlacement)
      .set({
        ownerNodeId: input.targetNodeId,
        fenceEpoch: () => '"fenceEpoch" + 1',
        localGeneration: input.targetGeneration,
        dirty: true,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where('id = :placementId', { placementId: input.placementId })
      .andWhere('"ownerNodeId" = :ownerNodeId', { ownerNodeId: input.expectedOwnerNodeId })
      .andWhere('"fenceEpoch" = :fenceEpoch', { fenceEpoch: String(input.expectedFenceEpoch) })
      .andWhere('"localGeneration" = :localGeneration', { localGeneration: input.expectedLocalGeneration })
      .andWhere(
        `EXISTS (
          SELECT 1
          FROM "workspace_operation" AS operation
          WHERE operation."id" = :operationId
            AND operation."placementId" = :placementId
            AND operation."phase" = 'target_verified'
            AND operation."leaseOwner" = :operationLeaseOwner
            AND operation."leaseExpiresAt" > :now
            AND operation."expectedFenceEpoch" = :operationExpectedFenceEpoch
            AND operation."sourceNodeId" = :operationSourceNodeId
            AND operation."targetNodeId" = :operationTargetNodeId
            AND operation."targetGeneration" = :targetGeneration
        )`,
        {
          operationId: input.operationId,
          operationLeaseOwner: input.operationLeaseOwner,
          operationExpectedFenceEpoch: String(input.expectedFenceEpoch),
          operationSourceNodeId: input.expectedOwnerNodeId,
          operationTargetNodeId: input.targetNodeId,
          targetGeneration: input.targetGeneration,
          now,
        },
      )
      .returning('*')
      .execute()
    const row = result.raw?.[0] as WorkspacePlacement | undefined
    if (!row) throw new ConflictException('workspace_owner_cas_miss')
    return row
  }

  private async switchOwnerAndRunner(input: {
    placementId: string
    sandboxId: string
    expectedOwnerNodeId: string
    expectedRunnerId: string
    expectedFenceEpoch: number
    expectedLocalGeneration: string
    operationId: string
    operationLeaseOwner: string
    targetNodeId: string
    targetRunnerId: string
    targetGeneration: string
    targetVerified: boolean
    now?: Date
  }): Promise<WorkspacePlacement> {
    assertUuid(input.sandboxId, 'sandbox_id_invalid')
    assertUuid(input.expectedRunnerId, 'expected_runner_id_invalid')
    assertUuid(input.targetRunnerId, 'target_runner_id_invalid')

    const now = input.now ?? new Date()
    return this.placementRepository.manager.transaction(async (transactionManager) => {
      const result = await transactionManager
        .createQueryBuilder()
        .update(WorkspacePlacement)
        .set({
          ownerNodeId: input.targetNodeId,
          fenceEpoch: () => '"fenceEpoch" + 1',
          localGeneration: input.targetGeneration,
          dirty: true,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where('id = :placementId', { placementId: input.placementId })
        .andWhere('"ownerNodeId" = :ownerNodeId', { ownerNodeId: input.expectedOwnerNodeId })
        .andWhere('"fenceEpoch" = :fenceEpoch', { fenceEpoch: String(input.expectedFenceEpoch) })
        .andWhere('"localGeneration" = :localGeneration', { localGeneration: input.expectedLocalGeneration })
        .andWhere(
          `EXISTS (
            SELECT 1
            FROM "workspace_operation" AS operation
            WHERE operation."id" = :operationId
              AND operation."placementId" = :placementId
              AND operation."phase" = 'target_verified'
              AND operation."leaseOwner" = :operationLeaseOwner
              AND operation."leaseExpiresAt" > :now
              AND operation."expectedFenceEpoch" = :operationExpectedFenceEpoch
              AND operation."sourceNodeId" = :operationSourceNodeId
              AND operation."targetNodeId" = :operationTargetNodeId
              AND operation."targetGeneration" = :targetGeneration
          )`,
          {
            operationId: input.operationId,
            operationLeaseOwner: input.operationLeaseOwner,
            operationExpectedFenceEpoch: String(input.expectedFenceEpoch),
            operationSourceNodeId: input.expectedOwnerNodeId,
            operationTargetNodeId: input.targetNodeId,
            targetGeneration: input.targetGeneration,
            now,
          },
        )
        .returning('*')
        .execute()
      const row = result.raw?.[0] as WorkspacePlacement | undefined
      if (!row) throw new ConflictException('workspace_owner_cas_miss')

      const sandboxResult = await transactionManager.update(
        'sandbox',
        { id: input.sandboxId, runnerId: input.expectedRunnerId },
        { prevRunnerId: input.expectedRunnerId, runnerId: input.targetRunnerId },
      )
      if (!sandboxResult.affected) throw new ConflictException('workspace_runner_assignment_conflict')
      return row
    })
  }
}

function assertWorkspaceIdentity(volumeId: string, subpath: string, sandboxId: string): void {
  assertUuid(sandboxId, 'sandbox_id_invalid')
  if (!VOLUME_ID_RE.test(volumeId)) throw new BadRequestException('volume_id_invalid')
  if (subpath !== `sandboxes/${sandboxId}/workspace` || subpath.includes('..') || subpath.startsWith('/')) {
    throw new BadRequestException('workspace_subpath_invalid')
  }
}

function assertUuid(value: string, code: string): void {
  if (!UUID_RE.test(value)) throw new BadRequestException(code)
}

function assertLeaseOwner(value: string): void {
  if (!value || value.length > 128 || /[\r\n]/.test(value)) throw new BadRequestException('lease_owner_invalid')
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505')
}
