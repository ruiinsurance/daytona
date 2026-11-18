/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { DataSource, EntityManager, FindOptionsWhere } from 'typeorm'
import { Sandbox } from '../entities/sandbox.entity'
import { SandboxLastActivity } from '../entities/sandbox-last-activity.entity'
import { Injectable, Logger, NotFoundException } from '@nestjs/common'
import { SandboxConflictError } from '../errors/sandbox-conflict.error'
import { InjectDataSource } from '@nestjs/typeorm'
import { EventEmitter2 } from '@nestjs/event-emitter'
import { BaseRepository } from '../../common/repositories/base.repository'
import { SandboxEvents } from '../constants/sandbox-events.constants'
import { SandboxStateUpdatedEvent } from '../events/sandbox-state-updated.event'
import { SandboxDesiredStateUpdatedEvent } from '../events/sandbox-desired-state-updated.event'
import { SandboxPublicStatusUpdatedEvent } from '../events/sandbox-public-status-updated.event'
import { SandboxOrganizationUpdatedEvent } from '../events/sandbox-organization-updated.event'
import { SandboxLookupCacheInvalidationService } from '../services/sandbox-lookup-cache-invalidation.service'
import { SandboxFork } from '../entities/sandbox-fork.entity'
import { Job } from '../entities/job.entity'
import { EntityNotFoundError, IsNull } from 'typeorm'
import { ConflictException } from '@nestjs/common'
import { archiveAndDeleteExpiredSandbox, assertSandboxIdentityNotRetained, loadRetainedSandboxMetadata, restoreRetainedSandboxMetadata, retainSandboxRecoveryDescriptor } from './sandbox-recovery-metadata'
import { historicalWorkspaceRecoverySandbox } from './historical-workspace-recovery'
import { Snapshot } from '../entities/snapshot.entity'
import { ResourceType } from '../enums/resource-type.enum'
import { SandboxState } from '../enums/sandbox-state.enum'
import { SandboxDesiredState } from '../enums/sandbox-desired-state.enum'

@Injectable()
export class SandboxRepository extends BaseRepository<Sandbox> {
  private readonly logger = new Logger(SandboxRepository.name)

  async deleteExpiredDestroyedSandbox(id: string, before: Date, assertLockOwned: () => Promise<void>): Promise<boolean> {
    return this.dataSource.transaction(async manager => {
      await manager.query("SET LOCAL lock_timeout='5s'")
      await manager.query("SET LOCAL statement_timeout='10s'")
      return archiveAndDeleteExpiredSandbox(manager, id, before, assertLockOwned)
    })
  }

  async retainedWorkspaceRecoverySandbox(
    sandboxId: string, organizationId: string, ownerRunnerId: string, materialize: boolean,
  ): Promise<Sandbox> {
    if (!materialize) {
      const metadata = await loadRetainedSandboxMetadata(this.manager, sandboxId, organizationId, ownerRunnerId)
      if (!metadata) throw new EntityNotFoundError(Sandbox, { id: sandboxId, organizationId })
      return Object.assign(new Sandbox(), metadata)
    }
    await this.dataSource.transaction(async manager => {
      if (!(await restoreRetainedSandboxMetadata(manager, sandboxId, organizationId, ownerRunnerId))) {
        throw new EntityNotFoundError(Sandbox, { id: sandboxId, organizationId })
      }
      await this.upsertLastActivity(manager, sandboxId, new Date())
    })
    const restored = await this.findOneOrFail({ where: { id: sandboxId, organizationId }, relations: ['buildInfo'] })
    this.invalidateLookupCacheOnInsert(restored)
    return restored
  }

  async historicalWorkspaceRecoverySandbox(
    sandboxId: string, organizationId: string, ownerRunnerId: string,
    expectedSnapshot: string | undefined, materialize: boolean,
  ): Promise<Sandbox> {
    if (!expectedSnapshot) throw new EntityNotFoundError(Sandbox, { id: sandboxId, organizationId })
    const build = async (manager: EntityManager, lock = false): Promise<{ sandbox: Sandbox; sourceCreateJobId: string }> => {
      const snapshot = await manager.getRepository(Snapshot).findOne({ where: { name: expectedSnapshot, organizationId } })
        ?? await manager.getRepository(Snapshot).findOne({ where: { name: expectedSnapshot, general: true } })
      if (!snapshot) throw new EntityNotFoundError(Sandbox, { id: sandboxId, organizationId })
      const query = manager.getRepository(Job).createQueryBuilder('job')
        .where('job.resourceId=:sandboxId AND job.resourceType=:resourceType', { sandboxId, resourceType: ResourceType.SANDBOX })
        .orderBy('job.createdAt', 'DESC').addOrderBy('job.id', 'DESC').take(101)
      if (lock) query.setLock('pessimistic_read')
      const jobs = await query.getMany()
      const sandbox = historicalWorkspaceRecoverySandbox({ sandboxId, organizationId, ownerRunnerId, expectedSnapshot, snapshot, jobs })
      const create = jobs.find(job => job.type === 'CREATE_SANDBOX' && job.status === 'COMPLETED')!
      return { sandbox, sourceCreateJobId: create.id }
    }
    if (!materialize) return (await build(this.manager)).sandbox
    await this.dataSource.transaction(async manager => {
      await manager.query("SELECT pg_advisory_xact_lock(hashtextextended('workspace-recovery:'||$1::text,0))", [sandboxId])
      if (await manager.getRepository(Sandbox).exists({ where: { id: sandboxId } })) {
        throw new ConflictException('Sandbox identity appeared during historical recovery')
      }
      const { sandbox: descriptor, sourceCreateJobId } = await build(manager, true)
      // The source ID was validated as canonical UUID. Keep secrets server-side
      // rather than placing env/auth values in SQL parameters or error logs.
      await manager.createQueryBuilder().insert().into(Sandbox).values({ ...descriptor,
        env: () => `(SELECT payload::jsonb->'env' FROM job WHERE id='${sourceCreateJobId}'::uuid)`,
        authToken: () => `replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')`,
      }).execute()
      const [row] = await manager.query('SELECT to_jsonb(s) AS metadata FROM sandbox s WHERE id=$1', [sandboxId])
      await retainSandboxRecoveryDescriptor(manager, row.metadata)
      await this.upsertLastActivity(manager, sandboxId, new Date())
    })
    const restored = await this.findOneOrFail({ where: { id: sandboxId, organizationId }, relations: ['buildInfo'] })
    this.invalidateLookupCacheOnInsert(restored)
    return restored
  }

  async hasIncompleteLifecycleJobs(sandboxId: string): Promise<boolean> {
    return this.dataSource.getRepository(Job).exists({
      where: { resourceId: sandboxId, resourceType: ResourceType.SANDBOX, completedAt: IsNull() },
    })
  }

  async withRebuildDispatch<T>(sandboxId: string, runnerId: string, action: (manager: EntityManager) => Promise<T>): Promise<T> {
    return this.dataSource.transaction(async manager => {
      const sandbox = await manager.findOne(Sandbox, { where: { id: sandboxId }, lock: { mode: 'pessimistic_write' } })
      if (!sandbox || sandbox.runnerId !== runnerId || sandbox.state !== SandboxState.STARTED
        || sandbox.desiredState !== SandboxDesiredState.STARTED || sandbox.pending) throw new SandboxConflictError()
      // Intent writers cannot change this row between validation and job insert.
      return action(manager)
    })
  }

  constructor(
    @InjectDataSource() dataSource: DataSource,
    eventEmitter: EventEmitter2,
    private readonly sandboxLookupCacheInvalidationService: SandboxLookupCacheInvalidationService,
  ) {
    super(dataSource, eventEmitter, Sandbox)
  }

  async insert(sandbox: Sandbox, parentId?: string): Promise<Sandbox> {
    const now = new Date()
    if (!sandbox.createdAt) {
      sandbox.createdAt = now
    }
    if (!sandbox.updatedAt) {
      sandbox.updatedAt = now
    }

    sandbox.assertValid()
    sandbox.enforceInvariants()

    await this.dataSource.transaction(async (entityManager) => {
      await assertSandboxIdentityNotRetained(entityManager, sandbox.id)
      await entityManager.insert(Sandbox, sandbox)
      await this.upsertLastActivity(entityManager, sandbox.id, sandbox.createdAt)
      sandbox.lastActivityAt = { sandboxId: sandbox.id, lastActivityAt: sandbox.createdAt }

      if (parentId) {
        await entityManager.insert(SandboxFork, {
          parentId,
          childId: sandbox.id,
        })
      }
    })

    this.invalidateLookupCacheOnInsert(sandbox)

    return sandbox
  }

  /**
   * @param id - The ID of the sandbox to update.
   * @param params.updateData - The partial data to update.
   *
   * @returns `void` because a raw update is performed.
   */
  async update(id: string, params: { updateData: Partial<Sandbox> }, raw: true): Promise<void>
  /**
   * @param id - The ID of the sandbox to update.
   * @param params.updateData - The partial data to update.
   * @param params.entity - Optional pre-fetched sandbox to use instead of fetching from the database.
   *
   * @returns The updated sandbox.
   */
  async update(id: string, params: { updateData: Partial<Sandbox>; entity?: Sandbox }, raw?: false): Promise<Sandbox>
  async update(
    id: string,
    params: { updateData: Partial<Sandbox>; entity?: Sandbox },
    raw = false,
  ): Promise<Sandbox | void> {
    const { updateData, entity } = params

    if (raw) {
      await this.repository.update(id, updateData)
      return
    }

    const sandbox = entity ?? (await this.findOneBy({ id }))
    if (!sandbox) {
      throw new NotFoundException('Sandbox not found')
    }

    const previousSandbox = { ...sandbox }

    Object.assign(sandbox, updateData)
    sandbox.assertValid()
    const invariantChanges = sandbox.enforceInvariants()

    await this.dataSource.transaction(async (entityManager) => {
      const result = await entityManager.update(
        Sandbox,
        {
          id: previousSandbox.id,
          state: previousSandbox.state,
          desiredState: previousSandbox.desiredState,
          pending: previousSandbox.pending,
          organizationId: previousSandbox.organizationId,
        },
        { ...updateData, ...invariantChanges },
      )
      if (!result.affected) {
        throw new SandboxConflictError()
      }
      sandbox.updatedAt = new Date()

      if (previousSandbox.state !== sandbox.state || previousSandbox.organizationId !== sandbox.organizationId) {
        await this.upsertLastActivity(entityManager, id, sandbox.updatedAt)
        sandbox.lastActivityAt = { sandboxId: id, lastActivityAt: sandbox.updatedAt }
      }
    })

    this.emitUpdateEvents(sandbox, previousSandbox)
    this.invalidateLookupCacheOnUpdate(sandbox, previousSandbox)

    return sandbox
  }

  /**
   * Partially updates a sandbox in the database and optionally emits a corresponding event based on the changes.
   *
   * Performs the update in a transaction with a pessimistic write lock to ensure consistency.
   *
   * @param id - The ID of the sandbox to update.
   * @param params.updateData - The partial data to update.
   * @param params.whereCondition - The where condition to use for the update.
   *
   * @throws {SandboxConflictError} if the sandbox was modified by another operation
   */
  async updateWhere(
    id: string,
    params: {
      updateData: Partial<Sandbox>
      whereCondition: FindOptionsWhere<Sandbox>
    },
  ): Promise<Sandbox> {
    const { updateData, whereCondition } = params

    return this.manager.transaction(async (entityManager) => {
      const whereClause = {
        ...whereCondition,
        id,
      }

      const sandbox = await entityManager.findOne(Sandbox, {
        where: whereClause,
        lock: { mode: 'pessimistic_write' },
        relations: [],
        loadEagerRelations: false,
      })

      if (!sandbox) {
        throw new SandboxConflictError()
      }

      const previousSandbox = { ...sandbox }

      Object.assign(sandbox, updateData)
      sandbox.assertValid()
      const invariantChanges = sandbox.enforceInvariants()

      await entityManager.update(Sandbox, id, { ...updateData, ...invariantChanges })
      sandbox.updatedAt = new Date()

      if (previousSandbox.state !== sandbox.state || previousSandbox.organizationId !== sandbox.organizationId) {
        await this.upsertLastActivity(entityManager, id, sandbox.updatedAt)
        sandbox.lastActivityAt = { sandboxId: id, lastActivityAt: sandbox.updatedAt }
      }

      this.emitUpdateEvents(sandbox, previousSandbox)
      this.invalidateLookupCacheOnUpdate(sandbox, previousSandbox)

      return sandbox
    })
  }

  /**
   * Upserts the last activity for a sandbox.
   */
  private async upsertLastActivity(
    entityManager: EntityManager,
    sandboxId: string,
    lastActivityAt: Date,
  ): Promise<void> {
    await entityManager.upsert(SandboxLastActivity, { sandboxId, lastActivityAt }, ['sandboxId'])
  }

  /**
   * Invalidates the sandbox lookup cache for the inserted sandbox.
   */
  private invalidateLookupCacheOnInsert(sandbox: Sandbox): void {
    try {
      this.sandboxLookupCacheInvalidationService.invalidateOrgId({
        sandboxId: sandbox.id,
        organizationId: sandbox.organizationId,
        name: sandbox.name,
      })
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue sandbox lookup cache invalidation on insert (id, organizationId, name) for ${sandbox.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Invalidates the sandbox lookup cache for the updated sandbox.
   */
  private invalidateLookupCacheOnUpdate(
    updatedSandbox: Sandbox,
    previousSandbox: Pick<Sandbox, 'organizationId' | 'name' | 'authToken'>,
  ): void {
    try {
      this.sandboxLookupCacheInvalidationService.invalidate({
        sandboxId: updatedSandbox.id,
        organizationId: updatedSandbox.organizationId,
        previousOrganizationId: previousSandbox.organizationId,
        name: updatedSandbox.name,
        previousName: previousSandbox.name,
      })
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue sandbox lookup cache invalidation on update (id, organizationId, name) for ${updatedSandbox.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }

    try {
      if (updatedSandbox.authToken !== previousSandbox.authToken) {
        this.sandboxLookupCacheInvalidationService.invalidate({
          authToken: updatedSandbox.authToken,
        })
      }
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue sandbox lookup cache invalidation on update (authToken) for ${updatedSandbox.id}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  /**
   * Emits events based on the changes made to a sandbox.
   */
  private emitUpdateEvents(
    updatedSandbox: Sandbox,
    previousSandbox: Pick<Sandbox, 'state' | 'desiredState' | 'public' | 'organizationId'>,
  ): void {
    if (previousSandbox.state !== updatedSandbox.state) {
      this.eventEmitter.emit(
        SandboxEvents.STATE_UPDATED,
        new SandboxStateUpdatedEvent(updatedSandbox, previousSandbox.state, updatedSandbox.state),
      )
    }

    if (previousSandbox.desiredState !== updatedSandbox.desiredState) {
      this.eventEmitter.emit(
        SandboxEvents.DESIRED_STATE_UPDATED,
        new SandboxDesiredStateUpdatedEvent(updatedSandbox, previousSandbox.desiredState, updatedSandbox.desiredState),
      )
    }

    if (previousSandbox.public !== updatedSandbox.public) {
      this.eventEmitter.emit(
        SandboxEvents.PUBLIC_STATUS_UPDATED,
        new SandboxPublicStatusUpdatedEvent(updatedSandbox, previousSandbox.public, updatedSandbox.public),
      )
    }

    if (previousSandbox.organizationId !== updatedSandbox.organizationId) {
      this.eventEmitter.emit(
        SandboxEvents.ORGANIZATION_UPDATED,
        new SandboxOrganizationUpdatedEvent(
          updatedSandbox,
          previousSandbox.organizationId,
          updatedSandbox.organizationId,
        ),
      )
    }
  }
}
