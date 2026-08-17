/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException } from '@nestjs/common'
import { assertDecimal, assertUuid } from './workspace-generation.contract'

export const MOVE_PHASES = [
  'requested',
  'leased',
  'quiescing',
  'local_checkpointed',
  'copying',
  'target_verified',
  'owner_switched',
  'target_started',
  'source_retained',
  'complete',
] as const

export type MovePhase = (typeof MOVE_PHASES)[number]

const NEXT_PHASE: Record<MovePhase, MovePhase | null> = {
  requested: 'leased',
  leased: 'quiescing',
  quiescing: 'local_checkpointed',
  local_checkpointed: 'copying',
  copying: 'target_verified',
  target_verified: 'owner_switched',
  owner_switched: 'target_started',
  target_started: 'source_retained',
  source_retained: 'complete',
  complete: null,
}

export function nextMovePhase(current: MovePhase): MovePhase | null {
  return NEXT_PHASE[current]
}

export function assertMoveTransition(current: MovePhase, next: MovePhase): void {
  if (NEXT_PHASE[current] !== next) throw new ConflictLikeError('invalid_move_phase_transition')
}

export function assertMoveIdentity(input: {
  operationId: string
  placementId: string
  volumeId: string
  sandboxId: string
  sourceNodeId: string
  targetNodeId: string
  expectedFenceEpoch: string
  idempotencyKey: string
}): void {
  assertUuid(input.operationId, 'operation_id_invalid')
  assertUuid(input.placementId, 'placement_id_invalid')
  assertUuid(input.volumeId, 'volume_id_invalid')
  assertUuid(input.sandboxId, 'sandbox_id_invalid')
  assertUuid(input.sourceNodeId, 'source_node_id_invalid')
  assertUuid(input.targetNodeId, 'target_node_id_invalid')
  assertDecimal(input.expectedFenceEpoch, 'workspace_fence_invalid')
  if (input.sourceNodeId === input.targetNodeId) throw new BadRequestException('move_target_equals_source')
  if (!input.idempotencyKey || input.idempotencyKey.length > 128 || /[\r\n]/.test(input.idempotencyKey)) {
    throw new BadRequestException('operation_idempotency_key_invalid')
  }
}

export function isTerminalMovePhase(phase: MovePhase): boolean {
  return phase === 'complete'
}

class ConflictLikeError extends Error {
  readonly code: string

  constructor(code: string) {
    super(code)
    this.code = code
  }
}
