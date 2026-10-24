/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

/** Only public operation identity and fixed terminal results cross the GET boundary. */
export function rebuildOperationView(record: unknown, sandboxId: string, operationId: string) {
  if (!record || typeof record !== 'object' || Array.isArray(record))
    throw new Error('Invalid rebuild operation evidence')
  const value = record as Record<string, unknown>
  if (
    value.sandboxId !== sandboxId ||
    value.operationId !== operationId ||
    typeof value.targetSnapshot !== 'string' ||
    !value.targetSnapshot.trim()
  ) {
    throw new Error('Invalid rebuild operation evidence')
  }
  const identity = { sandboxId, operationId, targetSnapshot: value.targetSnapshot }
  if (value.status === 'running')
    return {
      ...identity,
      status: 'running' as const,
      ...(value.stage === 'preflight' || value.stage === 'mutating' ? { stage: value.stage } : {}),
    }
  if (value.status !== 'complete' || !value.result || typeof value.result !== 'object' || Array.isArray(value.result)) {
    throw new Error('Invalid rebuild operation evidence')
  }
  const result = value.result as Record<string, unknown>
  if (
    ![
      'rebuilt',
      'rebuild_preflight_failed',
      'rebuild_failed_previous_restored',
      'rebuild_failed_rollback_failed',
    ].includes(String(result.outcome)) ||
    result.sandboxId !== sandboxId ||
    result.operationId !== operationId ||
    result.targetSnapshot !== value.targetSnapshot ||
    typeof result.previousSnapshot !== 'string' ||
    !result.previousSnapshot.trim() ||
    typeof result.ownerRunnerId !== 'string' ||
    !result.ownerRunnerId.trim()
  ) {
    throw new Error('Invalid rebuild operation evidence')
  }
  return {
    ...identity,
    status: 'complete' as const,
    result: {
      ...identity,
      outcome: result.outcome,
      previousSnapshot: result.previousSnapshot,
      ownerRunnerId: result.ownerRunnerId,
    },
  }
}
