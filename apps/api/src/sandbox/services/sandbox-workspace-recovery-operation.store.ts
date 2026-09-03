/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import Redis from 'ioredis'
import type {
  RecoverSandboxWorkspaceInput,
  RecoveredSandboxWorkspaceResult,
} from './sandbox-workspace-recovery.service'

const OPERATION_TTL_SECONDS = 7 * 24 * 60 * 60

export type SandboxWorkspaceRecoveryPhase = 'prepared' | 'binding_committed' | 'compute_requested'

export type SandboxWorkspaceRecoveryOperationRecord =
  | {
      status: 'running'
      phase: SandboxWorkspaceRecoveryPhase
      operationId: string
      sandboxId: string
      request: RecoverSandboxWorkspaceInput
    }
  | {
      status: 'complete'
      phase: 'complete'
      operationId: string
      sandboxId: string
      request: RecoverSandboxWorkspaceInput
      result: RecoveredSandboxWorkspaceResult
    }

@Injectable()
export class SandboxWorkspaceRecoveryOperationStore {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async get(sandboxId: string, operationId: string): Promise<SandboxWorkspaceRecoveryOperationRecord | null> {
    const raw = await this.redis.get(this.key(sandboxId, operationId))
    if (!raw) return null

    const value: unknown = JSON.parse(raw)
    if (!isOperationRecord(value, sandboxId, operationId)) {
      throw new Error('Invalid sandbox workspace recovery operation record')
    }
    return value
  }

  async begin(sandboxId: string, operationId: string, request: RecoverSandboxWorkspaceInput): Promise<boolean> {
    const record: SandboxWorkspaceRecoveryOperationRecord = {
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

  async advance(
    sandboxId: string,
    operationId: string,
    request: RecoverSandboxWorkspaceInput,
    phase: SandboxWorkspaceRecoveryPhase,
  ): Promise<void> {
    const record: SandboxWorkspaceRecoveryOperationRecord = {
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
       redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
       return 1`,
      2,
      this.activeKey(sandboxId),
      this.key(sandboxId, operationId),
      operationId,
      OPERATION_TTL_SECONDS,
      JSON.stringify(record),
    )
    if (Number(advanced) !== 1) {
      throw new Error('Sandbox workspace recovery operation ownership was lost')
    }
  }

  async complete(
    sandboxId: string,
    operationId: string,
    request: RecoverSandboxWorkspaceInput,
    result: RecoveredSandboxWorkspaceResult,
  ): Promise<void> {
    const record: SandboxWorkspaceRecoveryOperationRecord = {
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
    if (Number(completed) !== 1) {
      throw new Error('Sandbox workspace recovery operation ownership was lost')
    }
  }

  private key(sandboxId: string, operationId: string): string {
    return `sandbox-workspace-recovery-operation:${sandboxId}:${operationId}`
  }

  private activeKey(sandboxId: string): string {
    return `sandbox-workspace-recovery-active:${sandboxId}`
  }
}

function isOperationRecord(
  value: unknown,
  sandboxId: string,
  operationId: string,
): value is SandboxWorkspaceRecoveryOperationRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<SandboxWorkspaceRecoveryOperationRecord>
  if (
    record.operationId !== operationId ||
    record.sandboxId !== sandboxId ||
    (record.status !== 'running' && record.status !== 'complete') ||
    !isRecoveryRequest(record.request)
  ) {
    return false
  }
  if (record.status === 'running') {
    return ['prepared', 'binding_committed', 'compute_requested'].includes(String(record.phase))
  }
  return record.phase === 'complete' && isRecoveryResult(record.result, sandboxId, operationId, record.request)
}

function isRecoveryRequest(value: unknown): value is RecoverSandboxWorkspaceInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const request = value as Partial<RecoverSandboxWorkspaceInput>
  if (!request.workspace || typeof request.workspace !== 'object' || Array.isArray(request.workspace)) return false
  return (
    typeof request.operationId === 'string' &&
    typeof request.ownerRunnerId === 'string' &&
    typeof request.workspace.volumeId === 'string' &&
    request.workspace.mountPath === '/workspace' &&
    typeof request.workspace.subpath === 'string'
  )
}

function isRecoveryResult(
  value: unknown,
  sandboxId: string,
  operationId: string,
  request: RecoverSandboxWorkspaceInput,
): value is RecoveredSandboxWorkspaceResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Partial<RecoveredSandboxWorkspaceResult>
  return (
    result.outcome === 'recovered' &&
    result.operationId === operationId &&
    result.sandboxId === sandboxId &&
    result.externalId === sandboxId &&
    result.ownerRunnerId === request.ownerRunnerId &&
    result.status === 'running' &&
    Boolean(result.workspace) &&
    result.workspace?.volumeId === request.workspace.volumeId &&
    result.workspace?.mountPath === request.workspace.mountPath &&
    result.workspace?.subpath === request.workspace.subpath
  )
}
