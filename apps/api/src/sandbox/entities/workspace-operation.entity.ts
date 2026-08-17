/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'
import { MovePhase } from '../local-first/workspace-move.contract'

@Entity()
@Unique(['idempotencyKey'])
@Index(['sourceNodeId', 'phase'])
@Index(['placementId', 'phase'])
@Index('workspace_operation_active_placement_unique', ['placementId'], {
  unique: true,
  where: '"phase" <> \'complete\'',
})
export class WorkspaceOperation {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 32, default: 'move' })
  type: 'move'

  @Column({ type: 'varchar', length: 32 })
  phase: MovePhase

  @Column({ type: 'uuid' })
  placementId: string

  @Column({ type: 'varchar', length: 128 })
  volumeId: string

  @Column({ type: 'uuid' })
  sandboxId: string

  @Column({ type: 'uuid' })
  sourceNodeId: string

  @Column({ type: 'uuid' })
  targetNodeId: string

  @Column({ type: 'varchar', length: 128 })
  idempotencyKey: string

  @Column({ type: 'varchar', length: 128, nullable: true })
  leaseOwner: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  leaseExpiresAt: Date | null

  @Column({ type: 'bigint' })
  expectedFenceEpoch: string

  @Column({ type: 'bigint', nullable: true })
  checkpointGeneration: string | null

  @Column({ type: 'bigint', nullable: true })
  targetGeneration: string | null

  @Column({ type: 'varchar', length: 128, nullable: true })
  targetManifestHash: string | null

  @Column({ type: 'bigint', nullable: true })
  switchedFenceEpoch: string | null

  @Column({ type: 'varchar', length: 64, nullable: true })
  errorCode: string | null

  @Column({ type: 'boolean', default: false })
  sourceRetained: boolean

  @Column({ type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
