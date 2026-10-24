/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import type { LocalSandboxRebuildResult } from './sandbox-rebuild.service'
import { getStateChangeLockKey } from '../utils/lock-key.util'
import { SandboxConflictError } from '../errors/sandbox-conflict.error'

import { ADMIT_REBUILD_MUTATION, RECONCILE_EXPIRED_REBUILD_PREFLIGHT } from './sandbox-rebuild-operation.protocol'

const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60

export type SandboxRebuildOperationRecord =
  | {
      status: 'running'
      stage?: 'preflight' | 'mutating'
      previousSnapshot?: string
      ownerRunnerId?: string
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

  async hasActive(sandboxId: string): Promise<boolean> {
    return (await this.redis.get(this.activeKey(sandboxId))) !== null
  }

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

  async begin(
    sandboxId: string,
    operationId: string,
    targetSnapshot: string,
    preparation?: { previousSnapshot: string; ownerRunnerId: string },
  ): Promise<boolean> {
    const record: SandboxRebuildOperationRecord = {
      status: 'running',
      stage: preparation ? 'preflight' : 'mutating',
      ...preparation,
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

  async beginMutation(
    sandboxId: string,
    operationId: string,
    targetSnapshot: string,
    lockKey: string,
    lockCode: string,
  ): Promise<boolean> {
    const admitted = await this.redis.eval(
      ADMIT_REBUILD_MUTATION,
      2,
      lockKey,
      this.key(sandboxId, operationId),
      lockCode,
      sandboxId,
      operationId,
      targetSnapshot,
      OPERATION_TTL_SECONDS,
    )
    return Number(admitted) === 1
  }

  async reconcilePreparation(
    sandboxId: string,
    operationId: string,
    targetSnapshot: string,
    lockKey: string,
  ): Promise<SandboxRebuildOperationRecord | null> {
    await this.redis.eval(
      RECONCILE_EXPIRED_REBUILD_PREFLIGHT,
      3,
      lockKey,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      sandboxId,
      operationId,
      targetSnapshot,
      OPERATION_TTL_SECONDS,
    )
    return this.get(sandboxId, operationId)
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
    const completed = await this.redis.eval(
      `if redis.call('GET', KEYS[3]) ~= ARGV[1] or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
       local raw = redis.call('GET', KEYS[2])
       if not raw then return 0 end
       local old = cjson.decode(raw)
       if old.status ~= 'running' or old.targetSnapshot ~= ARGV[4]
         or old.operationId ~= ARGV[1] or old.sandboxId ~= ARGV[5] then return 0 end
       redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
       if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('DEL', KEYS[1])
       end
       return 1`,
      3,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      getStateChangeLockKey(sandboxId),
      operationId,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
      targetSnapshot,
      sandboxId,
    )
    if (Number(completed) !== 1) throw new SandboxConflictError()
  }

  private key(sandboxId: string, operationId: string): string {
    return `sandbox-rebuild-operation:${sandboxId}:${operationId}`
  }

  private activeKey(sandboxId: string): string {
    return `sandbox-rebuild-active:${sandboxId}`
  }
}
