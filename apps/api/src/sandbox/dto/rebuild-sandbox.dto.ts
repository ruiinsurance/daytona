/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ApiProperty, ApiSchema } from '@nestjs/swagger'
import { IsString, IsUUID } from 'class-validator'
import { IsSafeDisplayString } from '../../common/validators'

@ApiSchema({ name: 'RebuildSandbox' })
export class RebuildSandboxDto {
  @ApiProperty({
    description: 'Stable UUIDv4 idempotency key for this rebuild operation',
  })
  @IsUUID('4')
  operationId: string

  @ApiProperty({
    description: 'Existing Daytona snapshot name to use for the new compute generation',
  })
  @IsString()
  @IsSafeDisplayString()
  targetSnapshot: string
}
