/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import type { RecoverSandboxWorkspaceInput, SandboxWorkspaceRecoveryResult } from './sandbox-workspace-recovery.service'

const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60
const ACTIVE_OPERATION_TTL_SECONDS = 15 * 60

export type SandboxWorkspaceRecoveryOperationRecord =
  | ({ status: 'running'; sandboxId: string } & RecoverSandboxWorkspaceInput)
  | ({ status: 'complete'; sandboxId: string; result: SandboxWorkspaceRecoveryResult } & RecoverSandboxWorkspaceInput)

@Injectable()
export class SandboxWorkspaceRecoveryOperationStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async get(sandboxId: string, operationId: string): Promise<SandboxWorkspaceRecoveryOperationRecord | null> {
    const raw = await this.redis.get(this.key(sandboxId, operationId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Invalid workspace recovery operation record')
    }
    const record = value as Partial<SandboxWorkspaceRecoveryOperationRecord>
    if (
      (record.status !== 'running' && record.status !== 'complete') ||
      record.operationId !== operationId ||
      record.sandboxId !== sandboxId ||
      typeof record.ownerRunnerId !== 'string' ||
      !record.workspace ||
      typeof record.workspace !== 'object'
    ) {
      throw new Error('Invalid workspace recovery operation record')
    }
    if (record.status === 'complete' && (!record.result || typeof record.result !== 'object')) {
      throw new Error('Invalid completed workspace recovery operation record')
    }
    return record as SandboxWorkspaceRecoveryOperationRecord
  }

  async begin(sandboxId: string, input: RecoverSandboxWorkspaceInput): Promise<boolean> {
    const record: SandboxWorkspaceRecoveryOperationRecord = { status: 'running', sandboxId, ...input }
    const started = await this.redis.eval(
      `local active = redis.call('GET', KEYS[1])
       if active and active ~= ARGV[1] then return 0 end
       if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
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
    input: RecoverSandboxWorkspaceInput,
    result: SandboxWorkspaceRecoveryResult,
  ): Promise<void> {
    const record: SandboxWorkspaceRecoveryOperationRecord = { status: 'complete', sandboxId, ...input, result }
    await this.redis.eval(
      `redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
       if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
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
    return `sandbox-workspace-recovery-operation:${sandboxId}:${operationId}`
  }

  private activeKey(sandboxId: string): string {
    return `sandbox-workspace-recovery-active:${sandboxId}`
  }
}
