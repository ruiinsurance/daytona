/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import type {
  RecoverMissingComputeInput,
  RecoveredMissingComputeResult,
} from './sandbox-missing-compute-recovery.service'

const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60
const ACTIVE_OPERATION_TTL_SECONDS = 5 * 60

export type MissingComputeRecoveryOperationRecord =
  | {
      status: 'running'
      phase: 'prepared' | 'compute_requested'
      operationId: string
      sandboxId: string
      request: RecoverMissingComputeInput
    }
  | {
      status: 'complete'
      phase: 'complete'
      operationId: string
      sandboxId: string
      request: RecoverMissingComputeInput
      result: RecoveredMissingComputeResult
    }

@Injectable()
export class SandboxMissingComputeRecoveryOperationStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async get(sandboxId: string, operationId: string): Promise<MissingComputeRecoveryOperationRecord | null> {
    const raw = await this.redis.get(this.key(sandboxId, operationId))
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (!isOperationRecord(value, sandboxId, operationId)) {
      throw new Error('Invalid missing-compute recovery operation record')
    }
    return value
  }

  async begin(sandboxId: string, operationId: string, request: RecoverMissingComputeInput): Promise<boolean> {
    const record: MissingComputeRecoveryOperationRecord = {
      status: 'running',
      phase: 'prepared',
      operationId,
      sandboxId,
      request,
    }
    const started = await this.redis.eval(
      `local active = redis.call('GET', KEYS[1])
       if active or redis.call('EXISTS', KEYS[2]) == 1 then
         return 0
       end
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
       redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
      ACTIVE_OPERATION_TTL_SECONDS,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
    )
    return Number(started) === 1
  }

  async advance(
    sandboxId: string,
    operationId: string,
    request: RecoverMissingComputeInput,
    phase: 'compute_requested',
  ): Promise<void> {
    const record: MissingComputeRecoveryOperationRecord = {
      status: 'running',
      phase,
      operationId,
      sandboxId,
      request,
    }
    const advanced = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) == 0 then
         return 0
       end
       redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
       redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
      ACTIVE_OPERATION_TTL_SECONDS,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
    )
    if (Number(advanced) !== 1) throw new Error('Missing-compute recovery operation ownership was lost')
  }

  async complete(
    sandboxId: string,
    operationId: string,
    request: RecoverMissingComputeInput,
    result: RecoveredMissingComputeResult,
  ): Promise<void> {
    const record: MissingComputeRecoveryOperationRecord = {
      status: 'complete',
      phase: 'complete',
      operationId,
      sandboxId,
      request,
      result,
    }
    const completed = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2]) == 0 then
         return 0
       end
       redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
       redis.call('DEL', KEYS[1])
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
      JSON.stringify(record),
      OPERATION_TTL_SECONDS,
    )
    if (Number(completed) !== 1) throw new Error('Missing-compute recovery operation ownership was lost')
  }

  async abort(sandboxId: string, operationId: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         redis.call('DEL', KEYS[1])
         redis.call('DEL', KEYS[2])
         return 1
       end
       return 0`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
    )
  }

  private key(sandboxId: string, operationId: string): string {
    return `sandbox-missing-compute-recovery-operation:${sandboxId}:${operationId}`
  }

  private activeKey(sandboxId: string): string {
    return `sandbox-missing-compute-recovery-active:${sandboxId}`
  }
}

function isOperationRecord(
  value: unknown,
  sandboxId: string,
  operationId: string,
): value is MissingComputeRecoveryOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<MissingComputeRecoveryOperationRecord>
  if (
    record.operationId !== operationId ||
    record.sandboxId !== sandboxId ||
    !isRequest(record.request) ||
    (record.status !== 'running' && record.status !== 'complete')
  ) {
    return false
  }
  if (record.status === 'running') return record.phase === 'prepared' || record.phase === 'compute_requested'
  return record.phase === 'complete' && isResult(record.result, sandboxId, operationId, record.request)
}

function isRequest(value: unknown): value is RecoverMissingComputeInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Partial<RecoverMissingComputeInput>
  return Boolean(
    request.workspace &&
      typeof request.operationId === 'string' &&
      typeof request.ownerRunnerId === 'string' &&
      typeof request.workspace.volumeId === 'string' &&
      request.workspace.mountPath === '/workspace' &&
      typeof request.workspace.subpath === 'string',
  )
}

function isResult(
  value: unknown,
  sandboxId: string,
  operationId: string,
  request: RecoverMissingComputeInput,
): value is RecoveredMissingComputeResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Partial<RecoveredMissingComputeResult>
  return Boolean(
    result.outcome === 'recovered' &&
      result.operationId === operationId &&
      result.sandboxId === sandboxId &&
      result.externalId === sandboxId &&
      result.ownerRunnerId === request.ownerRunnerId &&
      result.status === 'running' &&
      typeof result.computeCreated === 'boolean' &&
      result.workspace?.volumeId === request.workspace.volumeId &&
      result.workspace?.mountPath === '/workspace' &&
      result.workspace?.subpath === request.workspace.subpath,
  )
}
