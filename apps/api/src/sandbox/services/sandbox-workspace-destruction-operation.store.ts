/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import type {
  DestroySandboxWorkspaceInput,
  SandboxWorkspaceDestructionResult,
} from './sandbox-workspace-destruction.service'

const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60
const ACTIVE_OPERATION_TTL_SECONDS = 15 * 60

export type SandboxWorkspaceDestructionOperationRecord =
  | ({ status: 'running'; sandboxId: string } & DestroySandboxWorkspaceInput)
  | ({
      status: 'complete'
      sandboxId: string
      result: SandboxWorkspaceDestructionResult
    } & DestroySandboxWorkspaceInput)

@Injectable()
export class SandboxWorkspaceDestructionOperationStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async get(sandboxId: string, operationId: string): Promise<SandboxWorkspaceDestructionOperationRecord | null> {
    const raw = await this.redis.get(this.key(sandboxId, operationId))
    if (!raw) return null

    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid workspace destruction operation record')
    }
    const record = value as Partial<SandboxWorkspaceDestructionOperationRecord>
    if (
      (record.status !== 'running' && record.status !== 'complete') ||
      record.operationId !== operationId ||
      record.sandboxId !== sandboxId ||
      typeof record.ownerRunnerId !== 'string' ||
      typeof record.volumeId !== 'string' ||
      typeof record.subpath !== 'string'
    ) {
      throw new Error('Invalid workspace destruction operation record')
    }
    if (record.status === 'complete' && (!record.result || typeof record.result !== 'object')) {
      throw new Error('Invalid completed workspace destruction operation record')
    }
    return record as SandboxWorkspaceDestructionOperationRecord
  }

  async begin(sandboxId: string, input: DestroySandboxWorkspaceInput): Promise<boolean> {
    const record: SandboxWorkspaceDestructionOperationRecord = {
      status: 'running',
      sandboxId,
      ...input,
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
       redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, input.operationId),
      input.operationId,
      ACTIVE_OPERATION_TTL_SECONDS,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
    )
    return Number(started) === 1
  }

  async complete(
    sandboxId: string,
    input: DestroySandboxWorkspaceInput,
    result: SandboxWorkspaceDestructionResult,
  ): Promise<void> {
    const record: SandboxWorkspaceDestructionOperationRecord = {
      status: 'complete',
      sandboxId,
      ...input,
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
      this.key(sandboxId, input.operationId),
      input.operationId,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
    )
  }

  private key(sandboxId: string, operationId: string): string {
    return `sandbox-workspace-destruction-operation:${sandboxId}:${operationId}`
  }

  private activeKey(sandboxId: string): string {
    return `sandbox-workspace-destruction-active:${sandboxId}`
  }
}
