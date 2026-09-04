/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { Equals, IsString, IsUUID, MaxLength, ValidateNested } from 'class-validator'

export class RecoverSandboxWorkspaceIdentityDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  volumeId: string

  @ApiProperty({ example: '/workspace' })
  @Equals('/workspace')
  mountPath: '/workspace'

  @ApiProperty({ example: 'sandboxes/00000000-0000-4000-8000-000000000000/workspace' })
  @IsString()
  @MaxLength(128)
  subpath: string
}

export class RecoverSandboxWorkspaceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  operationId: string

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  ownerRunnerId: string

  @ApiProperty({ type: RecoverSandboxWorkspaceIdentityDto })
  @ValidateNested()
  @Type(() => RecoverSandboxWorkspaceIdentityDto)
  workspace: RecoverSandboxWorkspaceIdentityDto
}
