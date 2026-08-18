/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { Repository } from 'typeorm'
import { WorkspaceOperation } from '../entities/workspace-operation.entity'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { StorageNode } from '../entities/storage-node.entity'
import { StorageNodeState } from '../enums/storage-node-state.enum'
import {
  assertMoveIdentity,
  assertMoveTransition,
  isTerminalMovePhase,
  MovePhase,
} from '../local-first/workspace-move.contract'
import { isStorageAgentErrorCode } from '../local-first/storage-agent-error.contract'
import { WorkspacePlacementService } from './workspace-placement.service'

const MOVE_OPERATION_LEASE_MS = 5 * 60 * 1000

export interface MoveRuntimeAdapter {
  quiesce(input: MoveRuntimeInput): Promise<void>
  checkpoint(input: MoveRuntimeInput): Promise<{ generation: string }>
  copy(input: MoveRuntimeInput): Promise<void>
  verifyTarget(input: MoveRuntimeInput): Promise<{ generation: string; manifestHash: string }>
  prepareTarget(input: MoveRuntimeInput): Promise<void>
  startTarget(input: MoveRuntimeInput): Promise<void>
  retainSource(input: MoveRuntimeInput): Promise<void>
}

export interface MoveRuntimeInput {
  operation: WorkspaceOperation
  fenceEpoch: string
  checkpointGeneration: string | null
  targetGeneration: string | null
}

@Injectable()
export class WorkspaceMoveService {
  private readonly workerId = randomUUID()

  constructor(
    @InjectRepository(WorkspaceOperation)
    private readonly operationRepository: Repository<WorkspaceOperation>,
    @InjectRepository(WorkspacePlacement)
    private readonly placementRepository: Repository<WorkspacePlacement>,
    @InjectRepository(StorageNode)
    private readonly storageNodeRepository: Repository<StorageNode>,
    private readonly workspacePlacementService: WorkspacePlacementService,
  ) {}

  async request(input: {
    operationId: string
    placementId: string
    volumeId: string
    sandboxId: string
    sourceNodeId: string
    targetNodeId: string
    expectedFenceEpoch: string
    idempotencyKey: string
    now?: Date
  }): Promise<WorkspaceOperation> {
    assertMoveIdentity(input)
    const existing = await this.operationRepository.findOne({ where: { idempotencyKey: input.idempotencyKey } })
    if (existing) return existing

    const active = await this.operationRepository.findOne({ where: { placementId: input.placementId } })
    if (active && !isTerminalMovePhase(active.phase)) {
      throw new ConflictException('move_operation_in_progress')
    }

    const placement = await this.placementRepository.findOne({ where: { id: input.placementId } })
    if (!placement) throw new NotFoundException('Workspace placement not found')
    if (
      placement.ownerNodeId !== input.sourceNodeId ||
      placement.fenceEpoch !== input.expectedFenceEpoch ||
      placement.volumeId !== input.volumeId ||
      placement.sandboxId !== input.sandboxId
    ) {
      throw new ConflictException('move_source_fence_conflict')
    }

    const target = await this.storageNodeRepository.findOne({ where: { nodeId: input.targetNodeId } })
    if (!target || target.state !== StorageNodeState.ACTIVE) throw new ConflictException('move_target_not_schedulable')

    const now = input.now ?? new Date()
    const operation = this.operationRepository.create({
      id: input.operationId,
      type: 'move',
      phase: 'requested',
      placementId: input.placementId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      sourceNodeId: input.sourceNodeId,
      targetNodeId: input.targetNodeId,
      idempotencyKey: input.idempotencyKey,
      leaseOwner: null,
      leaseExpiresAt: null,
      expectedFenceEpoch: input.expectedFenceEpoch,
      checkpointGeneration: null,
      targetGeneration: null,
      targetManifestHash: null,
      switchedFenceEpoch: null,
      errorCode: null,
      sourceRetained: false,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    try {
      return await this.operationRepository.save(operation)
    } catch (error) {
      if (isUniqueViolation(error)) {
        const concurrent = await this.operationRepository.findOne({
          where: { idempotencyKey: input.idempotencyKey },
        })
        if (concurrent) return concurrent
      }
      throw error
    }
  }

  async find(operationId: string): Promise<WorkspaceOperation> {
    const operation = await this.operationRepository.findOne({ where: { id: operationId } })
    if (!operation) throw new NotFoundException('Workspace operation not found')
    return operation
  }

  async run(operationId: string, runtime: MoveRuntimeAdapter, now = new Date()): Promise<WorkspaceOperation> {
    let operation = await this.find(operationId)
    if (isTerminalMovePhase(operation.phase)) return operation

    operation = await this.claimLease(operation, now)

    if (operation.phase === 'requested') {
      operation = await this.persistPhase(operation, 'leased', now)
    }

    if (operation.phase === 'leased') {
      await this.runPhaseAction(operation, runtime.quiesce, runtime)
      operation = await this.persistPhase(operation, 'quiescing', now)
    }
    if (operation.phase === 'quiescing') {
      operation = await this.ensureCheckpointGeneration(operation, now)
      const result = await this.runPhaseResult(operation, runtime.checkpoint, runtime)
      operation.checkpointGeneration = result.generation
      operation = await this.operationRepository.save(operation)
      operation = await this.persistPhase(operation, 'local_checkpointed', now)
    }
    if (operation.phase === 'local_checkpointed') {
      await this.runPhaseAction(operation, runtime.copy, runtime)
      operation = await this.persistPhase(operation, 'copying', now)
    }
    if (operation.phase === 'copying') {
      const result = await this.runPhaseResult(operation, runtime.verifyTarget, runtime)
      if (
        !result.manifestHash ||
        !/^[a-f0-9]{64}$/.test(result.manifestHash) ||
        result.generation !== operation.checkpointGeneration
      ) {
        operation.errorCode = 'move_phase_failed'
        await this.operationRepository.save(operation)
        throw new Error('move_phase_failed')
      }
      operation.targetGeneration = result.generation
      operation.targetManifestHash = result.manifestHash
      operation = await this.operationRepository.save(operation)
      operation = await this.persistPhase(operation, 'target_verified', now)
    }
    if (operation.phase === 'target_verified') {
      const target = await this.storageNodeRepository.findOne({ where: { nodeId: operation.targetNodeId } })
      if (!target || target.state !== StorageNodeState.ACTIVE) {
        operation.errorCode = 'move_target_not_schedulable'
        await this.operationRepository.save(operation)
        throw new Error('move_target_not_schedulable')
      }
      // Preparation waits on a bounded Runner job. Refresh the control-plane
      // lease immediately before sending the target-side evidence so the
      // storage agent cannot reject a valid move because earlier phases used
      // most of the original lease window.
      operation = await this.claimLease(operation, new Date())
      await this.runPhaseAction(operation, runtime.prepareTarget, runtime)
      const placement = await this.placementRepository.findOne({ where: { id: operation.placementId } })
      if (!placement) throw new NotFoundException('Workspace placement not found')
      const expectedFence = Number(operation.expectedFenceEpoch)
      const alreadySwitched =
        placement.ownerNodeId === operation.targetNodeId &&
        Number(placement.fenceEpoch) === expectedFence + 1 &&
        placement.localGeneration === operation.targetGeneration
      let switched: WorkspacePlacement
      if (alreadySwitched) {
        switched = placement
      } else {
        if (!operation.targetGeneration) {
          operation.errorCode = 'move_generation_invalid'
          await this.operationRepository.save(operation)
          throw new Error('move_generation_invalid')
        }
        switched = await this.workspacePlacementService.switchOwner({
          placementId: operation.placementId,
          expectedOwnerNodeId: operation.sourceNodeId,
          expectedFenceEpoch: expectedFence,
          expectedLocalGeneration: placement.localGeneration,
          operationId: operation.id,
          operationLeaseOwner: operation.leaseOwner ?? '',
          targetNodeId: operation.targetNodeId,
          targetGeneration: operation.targetGeneration,
          targetVerified: true,
          now,
        })
      }
      operation.switchedFenceEpoch = String(switched.fenceEpoch)
      operation = await this.operationRepository.save(operation)
      operation = await this.persistPhase(operation, 'owner_switched', now)
    }
    if (operation.phase === 'owner_switched') {
      await this.runPhaseAction(operation, runtime.startTarget, runtime)
      operation = await this.persistPhase(operation, 'target_started', now)
    }
    if (operation.phase === 'target_started') {
      await this.runPhaseAction(operation, runtime.retainSource, runtime)
      operation.sourceRetained = true
      operation = await this.operationRepository.save(operation)
      operation = await this.persistPhase(operation, 'source_retained', now)
    }
    if (operation.phase === 'source_retained') {
      operation.leaseOwner = null
      operation.leaseExpiresAt = null
      operation.completedAt = now
      operation = await this.persistPhase(operation, 'complete', now)
    }
    return operation
  }

  async hasBlockingOperations(nodeId: string): Promise<boolean> {
    const operations = await this.operationRepository.find()
    return operations.some(
      (operation) =>
        !isTerminalMovePhase(operation.phase) &&
        (operation.sourceNodeId === nodeId || operation.targetNodeId === nodeId),
    )
  }

  private async persistPhase(operation: WorkspaceOperation, next: MovePhase, now: Date): Promise<WorkspaceOperation> {
    const current = operation.phase
    assertMoveTransition(current, next)
    operation.phase = next
    operation.errorCode = null
    operation.updatedAt = now
    return this.operationRepository.save(operation)
  }

  private async runPhaseAction(
    operation: WorkspaceOperation,
    action: (input: MoveRuntimeInput) => Promise<void>,
    runtime: MoveRuntimeAdapter,
  ): Promise<void> {
    try {
      await action.call(runtime, this.runtimeInput(operation))
    } catch (error) {
      const errorCode = this.phaseErrorCode(error)
      operation.errorCode = errorCode
      await this.operationRepository.save(operation)
      throw new Error(errorCode)
    }
  }

  private async runPhaseResult<T extends { generation: string; manifestHash?: string }>(
    operation: WorkspaceOperation,
    action: (input: MoveRuntimeInput) => Promise<T>,
    runtime: MoveRuntimeAdapter,
  ): Promise<T> {
    try {
      const result = await action.call(runtime, this.runtimeInput(operation))
      if (!result.generation || !/^(0|[1-9][0-9]*)$/.test(result.generation)) {
        throw new Error('move_generation_invalid')
      }
      return result
    } catch (error) {
      const errorCode = this.phaseErrorCode(error)
      operation.errorCode = errorCode
      await this.operationRepository.save(operation)
      throw new Error(errorCode)
    }
  }

  private phaseErrorCode(error: unknown): string {
    return error instanceof Error && isStorageAgentErrorCode(error.message) ? error.message : 'move_phase_failed'
  }

  private runtimeInput(operation: WorkspaceOperation): MoveRuntimeInput {
    return {
      operation,
      fenceEpoch: operation.switchedFenceEpoch ?? operation.expectedFenceEpoch,
      checkpointGeneration: operation.checkpointGeneration,
      targetGeneration: operation.targetGeneration,
    }
  }

  private async ensureCheckpointGeneration(operation: WorkspaceOperation, now: Date): Promise<WorkspaceOperation> {
    if (operation.checkpointGeneration) return operation
    const placement = await this.placementRepository.findOne({ where: { id: operation.placementId } })
    if (!placement || !/^(0|[1-9][0-9]*)$/.test(placement.localGeneration)) {
      operation.errorCode = 'move_generation_invalid'
      await this.operationRepository.save(operation)
      throw new Error('move_generation_invalid')
    }
    operation.checkpointGeneration = (BigInt(placement.localGeneration) + 1n).toString()
    operation.updatedAt = now
    return this.operationRepository.save(operation)
  }

  private async claimLease(operation: WorkspaceOperation, now: Date): Promise<WorkspaceOperation> {
    const leaseOwner = `move-worker:${this.workerId}:${operation.id}`
    const leaseExpiresAt = new Date(now.getTime() + MOVE_OPERATION_LEASE_MS)
    const result = await this.operationRepository
      .createQueryBuilder()
      .update(WorkspaceOperation)
      .set({
        leaseOwner,
        leaseExpiresAt,
        updatedAt: now,
      })
      .where('id = :operationId', { operationId: operation.id })
      .andWhere('"phase" <> :complete', { complete: 'complete' })
      .andWhere('("leaseOwner" IS NULL OR "leaseExpiresAt" <= :now OR "leaseOwner" = :leaseOwner)', {
        now,
        leaseOwner,
      })
      .returning('*')
      .execute()
    const claimed = result.raw?.[0] as WorkspaceOperation | undefined
    if (claimed) return claimed

    const current = await this.find(operation.id)
    if (isTerminalMovePhase(current.phase)) return current
    const currentExpiry =
      current.leaseExpiresAt instanceof Date
        ? current.leaseExpiresAt
        : current.leaseExpiresAt
          ? new Date(current.leaseExpiresAt)
          : null
    if (
      current.leaseOwner &&
      current.leaseOwner !== leaseOwner &&
      (!currentExpiry || currentExpiry.getTime() > now.getTime())
    ) {
      throw new ConflictException('move_operation_lease_conflict')
    }
    throw new ConflictException('move_operation_lease_conflict')
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505')
}
