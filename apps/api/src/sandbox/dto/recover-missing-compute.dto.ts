/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { Equals, IsString, IsUUID, ValidateNested } from 'class-validator'

@ApiSchema({ name: 'RecoverMissingComputeWorkspace' })
export class RecoverMissingComputeWorkspaceDto {
  @ApiProperty({ description: 'Exact existing Runner-local physical Volume UUID' })
  @IsUUID('4')
  volumeId: string

  @ApiProperty({ enum: ['/workspace'], description: 'Canonical workspace mount path' })
  @Equals('/workspace')
  mountPath: '/workspace'

  @ApiProperty({ description: 'Canonical sandboxes/<sandboxId>/workspace subpath' })
  @IsString()
  subpath: string
}

@ApiSchema({ name: 'RecoverMissingCompute' })
export class RecoverMissingComputeDto {
  @ApiProperty({ description: 'Stable UUIDv4 idempotency key for this compute recovery operation' })
  @IsUUID('4')
  operationId: string

  @ApiProperty({ description: 'Exact persisted local Volume owner Runner UUID' })
  @IsUUID('4')
  ownerRunnerId: string

  @ApiProperty({ type: RecoverMissingComputeWorkspaceDto })
  @ValidateNested()
  @Type(() => RecoverMissingComputeWorkspaceDto)
  workspace: RecoverMissingComputeWorkspaceDto
}
