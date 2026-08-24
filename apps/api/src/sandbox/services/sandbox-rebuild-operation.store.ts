/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import type { LocalSandboxRebuildResult } from './sandbox-rebuild.service'

const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60

export type SandboxRebuildOperationRecord =
  | {
      status: 'running'
      operationId: string
      sandboxId: string
      targetSnapshot: string
    }
  | {
      status: 'complete'
      operationId: string
      sandboxId: string
      targetSnapshot: string
      result: LocalSandboxRebuildResult
    }

@Injectable()
export class SandboxRebuildOperationStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async get(sandboxId: string, operationId: string): Promise<SandboxRebuildOperationRecord | null> {
    const raw = await this.redis.get(this.key(sandboxId, operationId))
    if (!raw) return null

    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid sandbox rebuild operation record')
    }
    const record = value as Partial<SandboxRebuildOperationRecord>
    if (
      (record.status !== 'running' && record.status !== 'complete') ||
      record.operationId !== operationId ||
      record.sandboxId !== sandboxId ||
      typeof record.targetSnapshot !== 'string' ||
      !record.targetSnapshot
    ) {
      throw new Error('Invalid sandbox rebuild operation record')
    }
    if (record.status === 'complete' && (!record.result || typeof record.result !== 'object')) {
      throw new Error('Invalid completed sandbox rebuild operation record')
    }
    return record as SandboxRebuildOperationRecord
  }

  async begin(sandboxId: string, operationId: string, targetSnapshot: string): Promise<boolean> {
    const record: SandboxRebuildOperationRecord = {
      status: 'running',
      operationId,
      sandboxId,
      targetSnapshot,
    }
    const started = await this.redis.eval(
      `local active = redis.call('GET', KEYS[1])
       if active and active ~= ARGV[1] then
         return 0
       end
       if redis.call('EXISTS', KEYS[2]) == 1 then
         return 0
       end
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
       redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
      OPERATION_TTL_SECONDS,
      JSON.stringify(record),
    )
    return Number(started) === 1
  }

  async complete(
    sandboxId: string,
    operationId: string,
    targetSnapshot: string,
    result: LocalSandboxRebuildResult,
  ): Promise<void> {
    const record: SandboxRebuildOperationRecord = {
      status: 'complete',
      operationId,
      sandboxId,
      targetSnapshot,
      result,
    }
    await this.redis.eval(
      `redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
       if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('DEL', KEYS[1])
       end
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
    )
  }

  private key(sandboxId: string, operationId: string): string {
    return `sandbox-rebuild-operation:${sandboxId}:${operationId}`
  }

  private activeKey(sandboxId: string): string {
    return `sandbox-rebuild-active:${sandboxId}`
  }
}
