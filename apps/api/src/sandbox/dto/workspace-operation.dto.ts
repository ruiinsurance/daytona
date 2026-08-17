/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { IsUUID, IsString, Length } from 'class-validator'
import { ApiProperty } from '@nestjs/swagger'
import { WorkspaceOperation } from '../entities/workspace-operation.entity'
import { MovePhase } from '../local-first/workspace-move.contract'

export class RequestWorkspaceMoveDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  operationId: string

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  placementId: string

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  volumeId: string

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sourceNodeId: string

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  targetNodeId: string

  @ApiProperty({ example: '1' })
  @IsString()
  @Length(1, 32)
  expectedFenceEpoch: string

  @ApiProperty({ description: 'Client retry key; it never authorizes a second move.' })
  @IsString()
  @Length(1, 128)
  idempotencyKey: string
}

export class WorkspaceOperationDto {
  @ApiProperty({ format: 'uuid' })
  id: string

  @ApiProperty({ enum: [
    'requested', 'leased', 'quiescing', 'local_checkpointed', 'copying',
    'target_verified', 'owner_switched', 'target_started', 'source_retained', 'complete',
  ] })
  phase: MovePhase

  @ApiProperty({ format: 'uuid' })
  placementId: string

  @ApiProperty({ format: 'uuid' })
  sandboxId: string

  @ApiProperty({ format: 'uuid' })
  sourceNodeId: string

  @ApiProperty({ format: 'uuid' })
  targetNodeId: string

  @ApiProperty({ nullable: true })
  errorCode: string | null

  @ApiProperty()
  sourceRetained: boolean

  static fromOperation(operation: WorkspaceOperation): WorkspaceOperationDto {
    return {
      id: operation.id,
      phase: operation.phase,
      placementId: operation.placementId,
      sandboxId: operation.sandboxId,
      sourceNodeId: operation.sourceNodeId,
      targetNodeId: operation.targetNodeId,
      errorCode: operation.errorCode,
      sourceRetained: operation.sourceRetained,
    }
  }
}
