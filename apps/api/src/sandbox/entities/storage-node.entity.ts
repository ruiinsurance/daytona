import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique, UpdateDateColumn } from 'typeorm'
import { StorageNodeState } from '../enums/storage-node-state.enum'

@Entity()
@Unique(['runnerId'])
@Index(['state', 'heartbeatAt'])
export class StorageNode {
  @PrimaryColumn({ type: 'uuid' })
  nodeId: string

  @Column({ type: 'uuid' })
  runnerId: string

  @Column({ type: 'enum', enum: StorageNodeState, default: StorageNodeState.JOINING })
  state: StorageNodeState

  @Column({ type: 'bigint', default: 0 })
  capacityBytes: string

  @Column({ type: 'bigint', default: 0 })
  usedBytes: string

  @Column({ type: 'bigint', default: 0 })
  capacityInodes: string

  @Column({ type: 'bigint', default: 0 })
  usedInodes: string

  @Column({ type: 'jsonb', default: {} })
  labels: Record<string, string>

  @Column({ type: 'timestamp with time zone', nullable: true })
  heartbeatAt: Date | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  removedAt: Date | null

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
