/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Type } from 'class-transformer'
import { IsInt, IsObject, IsOptional, IsUUID, Matches, Min } from 'class-validator'
import { ApiProperty, ApiPropertyOptional, ApiSchema } from '@nestjs/swagger'
import { StorageNode } from '../entities/storage-node.entity'
import { StorageNodeState } from '../enums/storage-node-state.enum'

const VOLUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/

@ApiSchema({ name: 'RegisterStorageNode' })
export class RegisterStorageNodeDto {
  @ApiProperty({ description: 'Stable storage node identifier', format: 'uuid' })
  @IsUUID()
  nodeId: string

  @ApiProperty({ description: 'Total bytes available to the node', example: 1099511627776 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacityBytes: number

  @ApiProperty({ description: 'Total inodes available to the node', example: 10000000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacityInodes: number

  @ApiPropertyOptional({ description: 'Non-sensitive scheduling labels', type: Object })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>
}

@ApiSchema({ name: 'HeartbeatStorageNode' })
export class HeartbeatStorageNodeDto {
  @ApiProperty({ description: 'Total bytes available to the node', example: 1099511627776 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacityBytes: number

  @ApiProperty({ description: 'Bytes currently used by the node', example: 2147483648 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  usedBytes: number

  @ApiProperty({ description: 'Total inodes available to the node', example: 10000000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  capacityInodes: number

  @ApiProperty({ description: 'Inodes currently used by the node', example: 150000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  usedInodes: number

  @ApiPropertyOptional({ description: 'Non-sensitive scheduling labels', type: Object })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>
}

@ApiSchema({ name: 'MarkWorkspaceDirty' })
export class MarkWorkspaceDirtyDto {
  @ApiProperty({ description: 'Logical local-first volume identity' })
  @Matches(VOLUME_ID_RE)
  volumeId: string

  @ApiProperty({ description: 'Stable Suna sandbox identity', format: 'uuid' })
  @IsUUID()
  sandboxId: string

  @ApiPropertyOptional({ description: 'Monotonic local generation observation', pattern: '^(0|[1-9][0-9]*)$' })
  @IsOptional()
  @Matches(DECIMAL_RE)
  localGeneration?: string
}

@ApiSchema({ name: 'MarkWorkspaceDirtyResponse' })
export class MarkWorkspaceDirtyResponseDto {
  @ApiProperty({ example: true })
  accepted: boolean
}

@ApiSchema({ name: 'StorageNode' })
export class StorageNodeDto {
  @ApiProperty({ format: 'uuid' })
  nodeId: string

  @ApiProperty({ format: 'uuid' })
  runnerId: string

  @ApiProperty({ enum: StorageNodeState })
  state: StorageNodeState

  @ApiProperty({ description: 'Bigint values are returned as decimal strings', example: '1099511627776' })
  capacityBytes: string

  @ApiProperty({ description: 'Bigint values are returned as decimal strings', example: '2147483648' })
  usedBytes: string

  @ApiProperty({ description: 'Bigint values are returned as decimal strings', example: '10000000' })
  capacityInodes: string

  @ApiProperty({ description: 'Bigint values are returned as decimal strings', example: '150000' })
  usedInodes: string

  @ApiProperty({ type: Object })
  labels: Record<string, string>

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  heartbeatAt: Date | null

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  removedAt: Date | null

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date

  static fromStorageNode(node: StorageNode): StorageNodeDto {
    return {
      nodeId: node.nodeId,
      runnerId: node.runnerId,
      state: node.state,
      capacityBytes: node.capacityBytes,
      usedBytes: node.usedBytes,
      capacityInodes: node.capacityInodes,
      usedInodes: node.usedInodes,
      labels: node.labels ?? {},
      heartbeatAt: node.heartbeatAt,
      removedAt: node.removedAt,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    }
  }
}
