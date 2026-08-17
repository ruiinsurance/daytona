/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { randomUUID } from 'node:crypto'
import { Repository } from 'typeorm'
import { StorageNode } from '../entities/storage-node.entity'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { StorageNodeState } from '../enums/storage-node-state.enum'
import { StorageNodeService } from './storage-node.service'
import { WorkspaceMoveService } from './workspace-move.service'

@Injectable()
export class WorkspaceDrainService {
  constructor(
    @InjectRepository(StorageNode)
    private readonly storageNodeRepository: Repository<StorageNode>,
    @InjectRepository(WorkspacePlacement)
    private readonly placementRepository: Repository<WorkspacePlacement>,
    private readonly storageNodeService: StorageNodeService,
    private readonly workspaceMoveService: WorkspaceMoveService,
  ) {}

  async reconcileOnce(maxMoves = 10): Promise<{ requested: number; drained: number }> {
    const limit = Number.isSafeInteger(maxMoves) && maxMoves > 0 ? Math.min(maxMoves, 100) : 10
    const nodes = await this.storageNodeRepository.find({
      where: { state: StorageNodeState.DRAINING },
      order: { nodeId: 'ASC' },
    })
    let requested = 0
    let drained = 0

    for (const node of nodes) {
      const placements = await this.placementRepository.find({
        where: { ownerNodeId: node.nodeId },
        order: { id: 'ASC' },
        take: Math.max(1, limit - requested),
      })
      if (placements.length === 0) {
        if (!(await this.workspaceMoveService.hasBlockingOperations(node.nodeId))) {
          await this.storageNodeService.transition(node.nodeId, StorageNodeState.DRAINED, node.runnerId)
          drained += 1
        }
        continue
      }

      for (const placement of placements) {
        if (requested >= limit) break
        let target: { nodeId: string; reason: 'owner_affinity' | 'capacity_score' }
        try {
          target = await this.storageNodeService.chooseNode({
            now: new Date(),
            requiredBytes: 0,
            requiredInodes: 1,
          })
        } catch {
          // No healthy target means the node remains draining; the next
          // bounded reconciliation retries after heartbeat/capacity changes.
          continue
        }
        if (target.nodeId === node.nodeId) continue
        await this.workspaceMoveService.request({
          operationId: randomUUID(),
          placementId: placement.id,
          volumeId: placement.volumeId,
          sandboxId: placement.sandboxId,
          sourceNodeId: node.nodeId,
          targetNodeId: target.nodeId,
          expectedFenceEpoch: placement.fenceEpoch,
          idempotencyKey: `drain:${node.nodeId}:${placement.id}`,
        })
        requested += 1
      }
    }

    return { requested, drained }
  }
}
