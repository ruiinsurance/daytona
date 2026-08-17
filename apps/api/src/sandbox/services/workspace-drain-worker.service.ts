/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Cron, CronExpression } from '@nestjs/schedule'
import { Injectable } from '@nestjs/common'
import { WorkspaceDrainService } from './workspace-drain.service'

@Injectable()
export class WorkspaceDrainWorker {
  constructor(private readonly drainService: WorkspaceDrainService) {}

  @Cron(CronExpression.EVERY_10_SECONDS, { name: 'local-first-drain-reconcile', waitForCompletion: true })
  async reconcileOnce(): Promise<{ requested: number; drained: number }> {
    return this.drainService.reconcileOnce()
  }
}
