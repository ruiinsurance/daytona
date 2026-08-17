/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Cron, CronExpression } from '@nestjs/schedule'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { WorkspaceOperation } from '../entities/workspace-operation.entity'
import { MoveRuntimeAdapter, WorkspaceMoveService } from './workspace-move.service'
import {
  LOCAL_FIRST_MOVE_BATCH_SIZE,
  LOCAL_FIRST_MOVE_RECONCILER,
  LOCAL_FIRST_MOVE_RUNTIME,
} from '../local-first/workspace-move.tokens'

export interface MoveReconciler {
  drainOnce(): Promise<number>
}

@Injectable()
export class WorkspaceMoveReconciler implements MoveReconciler {
  private readonly batchSize: number

  constructor(
    @InjectRepository(WorkspaceOperation)
    private readonly operationRepository: Repository<WorkspaceOperation>,
    private readonly moveService: WorkspaceMoveService,
    @Optional() @Inject(LOCAL_FIRST_MOVE_RUNTIME)
    private readonly runtime?: MoveRuntimeAdapter,
    @Optional() @Inject(LOCAL_FIRST_MOVE_BATCH_SIZE)
    batchSize?: number,
  ) {
    this.batchSize = Number.isSafeInteger(batchSize) && (batchSize as number) > 0
      ? Math.min(batchSize as number, 100)
      : 10
  }

  async drainOnce(): Promise<number> {
    // A runtime adapter is the explicit storage-agent boundary. Without one,
    // queued operations remain durable and visible but no host-side action is attempted.
    if (!this.runtime) return 0

    const operations = await this.operationRepository
      .createQueryBuilder('operation')
      .where('operation.phase <> :complete', { complete: 'complete' })
      .orderBy('operation."updatedAt"', 'ASC')
      .take(this.batchSize)
      .getMany()

    let completed = 0
    for (const operation of operations) {
      try {
        const result = await this.moveService.run(operation.id, this.runtime)
        if (result.phase === 'complete') completed += 1
      } catch {
        // WorkspaceMoveService records a fixed phase error and keeps the
        // operation resumable; one failed move must not starve the batch.
      }
    }
    return completed
  }
}

@Injectable()
export class WorkspaceMoveWorker {
  constructor(
    @Optional() @Inject(LOCAL_FIRST_MOVE_RECONCILER)
    private readonly reconciler?: MoveReconciler,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'local-first-move-reconcile', waitForCompletion: true })
  async reconcileOnce(): Promise<number> {
    if (!this.reconciler) return 0
    return this.reconciler.drainOnce()
  }
}
