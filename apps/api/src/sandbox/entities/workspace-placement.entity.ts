import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm'

@Entity()
@Unique(['volumeId', 'subpath'])
@Unique(['sandboxId'])
@Index(['ownerNodeId', 'fenceEpoch'])
export class WorkspacePlacement {
  @PrimaryGeneratedColumn('uuid')
  id: string

  @Column({ type: 'varchar', length: 128 })
  volumeId: string

  @Column({ type: 'varchar', length: 512 })
  subpath: string

  @Column({ type: 'uuid' })
  sandboxId: string

  @Column({ type: 'uuid', nullable: true })
  ownerNodeId: string | null

  @Column({ type: 'bigint', default: 0 })
  localGeneration: string

  @Column({ type: 'bigint', default: 0 })
  cosGeneration: string

  @Column({ type: 'bigint', default: 1 })
  fenceEpoch: string

  @Column({ type: 'text', nullable: true })
  leaseOwner: string | null

  @Column({ type: 'timestamp with time zone', nullable: true })
  leaseExpiresAt: Date | null

  @Column({ type: 'varchar', length: 32, default: 'pending' })
  replicationStatus: string

  @Column({ type: 'boolean', default: true })
  dirty: boolean

  @CreateDateColumn({ type: 'timestamp with time zone' })
  createdAt: Date

  @UpdateDateColumn({ type: 'timestamp with time zone' })
  updatedAt: Date
}
