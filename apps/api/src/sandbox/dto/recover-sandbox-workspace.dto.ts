/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { Equals, IsString, IsUUID, ValidateNested } from 'class-validator'

@ApiSchema({ name: 'RecoverSandboxWorkspaceMount' })
export class RecoverSandboxWorkspaceMountDto {
  @ApiProperty({ description: 'Exact UUIDv4 of the independently restored replacement Volume' })
  @IsUUID('4')
  volumeId: string

  @ApiProperty({ enum: ['/workspace'], description: 'Canonical workspace mount path' })
  @Equals('/workspace')
  mountPath: '/workspace'

  @ApiProperty({ description: 'Canonical sandboxes/<sandboxId>/workspace subpath' })
  @IsString()
  subpath: string
}

@ApiSchema({ name: 'RecoverSandboxWorkspace' })
export class RecoverSandboxWorkspaceDto {
  @ApiProperty({ description: 'Stable UUIDv4 idempotency key for this recovery operation' })
  @IsUUID('4')
  operationId: string

  @ApiProperty({ description: 'Exact owner Runner UUID attested by the backup generation' })
  @IsUUID('4')
  ownerRunnerId: string

  @ApiProperty({ type: RecoverSandboxWorkspaceMountDto })
  @ValidateNested()
  @Type(() => RecoverSandboxWorkspaceMountDto)
  workspace: RecoverSandboxWorkspaceMountDto
}
