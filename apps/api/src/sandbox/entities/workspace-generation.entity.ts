/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { WorkspaceGenerationState } from '../enums/workspace-generation-state.enum'

@Entity()
@Unique(['placementId', 'generation'])
@Index(['placementId', 'state'])
export class WorkspaceGeneration {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'uuid' })
  operationId: string

  @Column({ type: 'uuid' })
  placementId: string

  @Column({ type: 'varchar', length: 128 })
  volumeId: string

  @Column({ type: 'uuid' })
  sandboxId: string

  @Column({ type: 'bigint' })
  generation: string

  @Column({ type: 'varchar', length: 24 })
  state: WorkspaceGenerationState

  @Column({ type: 'varchar', length: 1024 })
  sourcePath: string

  @Column({ type: 'varchar', length: 128 })
  manifestHash: string

  @Column({ type: 'bigint', default: 0 })
  objectCount: string

  @Column({ type: 'bigint', default: 0 })
  bytes: string

  @Column({ type: 'jsonb' })
  manifest: Record<string, unknown>

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  committedAt: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
