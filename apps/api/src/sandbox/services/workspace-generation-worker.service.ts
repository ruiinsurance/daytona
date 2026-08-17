/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Cron, CronExpression } from '@nestjs/schedule'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { Repository } from 'typeorm'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { WorkspaceGenerationService } from './workspace-generation.service'
import {
  GenerationObjectStore,
  ImmutableCheckpointSource,
} from '../local-first/workspace-generation.contract'
import {
  LOCAL_FIRST_GENERATION_BATCH_SIZE,
  LOCAL_FIRST_GENERATION_RECONCILER,
  LOCAL_FIRST_GENERATION_SOURCE,
  LOCAL_FIRST_GENERATION_STORE,
} from '../local-first/workspace-generation.tokens'

export interface GenerationReconciler {
  drainOnce(): Promise<number>
}

@Injectable()
export class WorkspaceGenerationReconciler implements GenerationReconciler {
  private readonly batchSize: number

  constructor(
    @InjectRepository(WorkspacePlacement)
    private readonly placementRepository: Repository<WorkspacePlacement>,
    private readonly generationService: WorkspaceGenerationService,
    @Optional() @Inject(LOCAL_FIRST_GENERATION_SOURCE)
    private readonly source?: ImmutableCheckpointSource,
    @Optional() @Inject(LOCAL_FIRST_GENERATION_STORE)
    private readonly store?: GenerationObjectStore,
    @Optional() @Inject(LOCAL_FIRST_GENERATION_BATCH_SIZE)
    batchSize?: number,
  ) {
    this.batchSize = Number.isSafeInteger(batchSize) && (batchSize as number) > 0
      ? Math.min(batchSize as number, 1000)
      : 25
  }

  async drainOnce(): Promise<number> {
    // The API process is deliberately inert until a storage-agent source and
    // object store are explicitly configured. This keeps a partial deployment
    // from probing COS or a guessed local path.
    if (!this.source || !this.store) return 0

    const placements = await this.placementRepository
      .createQueryBuilder('placement')
      .where('placement.dirty = :dirty OR placement."localGeneration" > placement."cosGeneration"', { dirty: true })
      .orderBy('placement."updatedAt"', 'ASC')
      .take(this.batchSize)
      .getMany()

    let committed = 0
    for (const placement of placements) {
      try {
        const result = await this.generationService.reconcile({
          placementId: placement.id,
          source: this.source,
          store: this.store,
        })
        if (result.outcome === 'committed' || result.outcome === 'committed_pending_latest') {
          committed += 1
        }
      } catch {
        // WorkspaceGenerationService persists a fixed failure category and
        // leaves the placement dirty. Continue with the rest of the batch.
      }
    }
    return committed
  }
}

@Injectable()
export class WorkspaceGenerationWorker {
  constructor(
    @Optional() @Inject(LOCAL_FIRST_GENERATION_RECONCILER)
    private readonly reconciler?: GenerationReconciler,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE, { name: 'local-first-generation-reconcile', waitForCompletion: true })
  async reconcileOnce(): Promise<number> {
    if (!this.reconciler) return 0
    return this.reconciler.drainOnce()
  }
}
