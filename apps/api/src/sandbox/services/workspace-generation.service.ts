/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, Optional } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { createHash, randomUUID } from 'node:crypto'
import { Repository } from 'typeorm'
import { WorkspaceGeneration } from '../entities/workspace-generation.entity'
import { WorkspaceGenerationState } from '../enums/workspace-generation-state.enum'
import { WorkspacePlacement } from '../entities/workspace-placement.entity'
import { WorkspacePlacementService } from './workspace-placement.service'
import {
  assertManifestMatches,
  buildGenerationObjectKey,
  buildWorkspaceGenerationKey,
  chooseRecoverySource,
  GENERATION_COMMIT_MARKER,
  GENERATION_LATEST_NAME,
  GENERATION_MANIFEST_NAME,
  GenerationManifest,
  GenerationObjectStore,
  ImmutableCheckpoint,
  ImmutableCheckpointSource,
  manifestHash,
  assertUuid,
  assertDecimal,
  checkpointContentHash,
} from '../local-first/workspace-generation.contract'
import { LOCAL_FIRST_GENERATION_PREFIX } from '../local-first/workspace-generation.tokens'

const FIXED_UPLOAD_ERROR = 'generation_upload_failed'
const FIXED_PERSIST_ERROR = 'generation_persist_failed'
const VOLUME_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

@Injectable()
export class WorkspaceGenerationService {
  private readonly workerId = randomUUID()

  constructor(
    @InjectRepository(WorkspaceGeneration)
    private readonly generationRepository: Repository<WorkspaceGeneration>,
    @InjectRepository(WorkspacePlacement)
    private readonly placementRepository: Repository<WorkspacePlacement>,
    private readonly workspacePlacementService: WorkspacePlacementService,
    @Optional()
    @Inject(LOCAL_FIRST_GENERATION_PREFIX)
    private readonly generationPrefix = 'local-first',
  ) {}

  async markDirty(input: {
    placementId: string
    ownerNodeId?: string
    localGeneration?: string
  }): Promise<WorkspacePlacement> {
    assertUuid(input.placementId, 'placement_id_invalid')
    if (input.ownerNodeId) assertUuid(input.ownerNodeId, 'owner_node_id_invalid')
    const placement = await this.placementRepository.findOne({ where: { id: input.placementId } })
    if (!placement) throw new NotFoundException('Workspace placement not found')

    if (input.localGeneration !== undefined) {
      assertDecimal(input.localGeneration, 'local_generation_invalid')
      assertDecimal(placement.localGeneration, 'local_generation_invalid')
      assertDecimal(placement.cosGeneration, 'cos_generation_invalid')
      const incomingGeneration = BigInt(input.localGeneration)
      if (
        incomingGeneration < BigInt(placement.localGeneration) ||
        incomingGeneration < BigInt(placement.cosGeneration)
      ) {
        throw new ConflictException('local_generation_regression')
      }
    }

    const now = new Date()
    const update = {
      dirty: true,
      replicationStatus: () => `CASE WHEN "replicationStatus" = 'durable' THEN 'pending' ELSE "replicationStatus" END`,
      updatedAt: now,
      ...(input.localGeneration === undefined
        ? {}
        : {
            localGeneration: () => 'GREATEST("localGeneration", CAST(:incomingGeneration AS bigint))',
          }),
    }
    const query = this.placementRepository
      .createQueryBuilder()
      .update(WorkspacePlacement)
      .set(update)
      .where('id = :placementId', { placementId: input.placementId })

    if (input.ownerNodeId) {
      query.andWhere('"ownerNodeId" = :ownerNodeId', { ownerNodeId: input.ownerNodeId })
    }
    if (input.localGeneration !== undefined) {
      query.setParameter('incomingGeneration', input.localGeneration)
    }

    const result = await query.returning('*').execute()
    const row = result.raw?.[0] as WorkspacePlacement | undefined
    if (!row) {
      throw new ConflictException(input.ownerNodeId ? 'workspace_owner_changed' : 'workspace_dirty_update_conflict')
    }
    return row
  }

  async markDirtyByIdentity(input: {
    volumeId: string
    sandboxId: string
    ownerNodeId: string
    localGeneration?: string
  }): Promise<WorkspacePlacement> {
    if (!VOLUME_ID_RE.test(input.volumeId)) throw new BadRequestException('volume_id_invalid')
    assertUuid(input.sandboxId, 'sandbox_id_invalid')
    assertUuid(input.ownerNodeId, 'owner_node_id_invalid')

    const placement = await this.placementRepository.findOne({
      where: { volumeId: input.volumeId, sandboxId: input.sandboxId },
    })
    if (!placement) throw new NotFoundException('Workspace placement not found')
    if (placement.ownerNodeId !== input.ownerNodeId) {
      throw new ConflictException('workspace_owner_affinity_conflict')
    }

    return this.markDirty({
      placementId: placement.id,
      ownerNodeId: input.ownerNodeId,
      localGeneration: input.localGeneration,
    })
  }

  async reconcile(input: {
    placementId: string
    source: ImmutableCheckpointSource
    store: GenerationObjectStore
    sourcePath?: string
    now?: Date
  }): Promise<{ outcome: 'committed' | 'committed_pending_latest' | 'skipped'; generation?: WorkspaceGeneration }> {
    const placement = await this.placementRepository.findOne({ where: { id: input.placementId } })
    if (!placement) throw new NotFoundException('Workspace placement not found')

    const localGeneration = BigInt(placement.localGeneration || '0')
    const cosGeneration = BigInt(placement.cosGeneration || '0')
    if (!placement.dirty && localGeneration <= cosGeneration) return { outcome: 'skipped' }
    if (!placement.ownerNodeId) throw new Error('recovery_required')
    assertUuid(placement.ownerNodeId, 'owner_node_id_invalid')

    const workspaceKey = buildWorkspaceGenerationKey(placement.volumeId, placement.sandboxId, this.generationPrefix)
    const alreadyCommitted = await this.generationRepository.findOne({
      where: { placementId: placement.id, generation: placement.localGeneration },
    })
    if (alreadyCommitted?.state === WorkspaceGenerationState.COMMITTED) {
      return this.publishCommittedLatest({
        placement,
        generation: placement.localGeneration,
        workspaceKey,
        generationRow: alreadyCommitted,
        store: input.store,
      })
    }

    const nextGeneration = (localGeneration + 1n).toString()
    const nextGenerationRow = await this.generationRepository.findOne({
      where: { placementId: placement.id, generation: nextGeneration },
    })
    if (nextGenerationRow?.state === WorkspaceGenerationState.COMMITTED) {
      return this.publishCommittedLatest({
        placement,
        generation: nextGeneration,
        workspaceKey,
        generationRow: nextGenerationRow,
        store: input.store,
      })
    }

    const checkpointLease = await this.acquireCheckpointLease(placement, input.now ?? new Date())
    // The lease is acquired with a conditional SQL update and may be returned
    // as a different entity instance. Carry its authoritative identity into
    // every later placement save so replication state cannot clear the writer
    // fence while the immutable checkpoint is still being published.
    placement.fenceEpoch = checkpointLease.fenceEpoch
    placement.leaseOwner = checkpointLease.leaseOwner
    placement.leaseExpiresAt = new Date(checkpointLease.leaseExpiresAt)
    let generation: WorkspaceGeneration
    try {
      generation = await this.prepareGenerationIntent(
        placement,
        nextGeneration,
        nextGenerationRow,
        input.now ?? new Date(),
      )

      let checkpoint: ImmutableCheckpoint
      try {
        checkpoint = await input.source.create({
          volumeId: placement.volumeId,
          sandboxId: placement.sandboxId,
          sourcePath:
            input.sourcePath ??
            `/srv/kortix-storage/nodes/${placement.ownerNodeId}/volumes/${placement.volumeId}/sandboxes/${placement.sandboxId}/workspace`,
          nextGeneration,
          ownerNodeId: placement.ownerNodeId,
          operationId: generation.operationId,
          fenceEpoch: checkpointLease.fenceEpoch,
          leaseOwner: checkpointLease.leaseOwner,
          leaseExpiresAt: checkpointLease.leaseExpiresAt,
        })
        if (checkpoint.generation !== nextGeneration) throw new ConflictException('checkpoint_generation_conflict')
        assertCheckpointIntegrity(checkpoint, placement.volumeId, placement.sandboxId, nextGeneration)
      } catch (error) {
        await this.markGenerationFailed(generation, placement, 'checkpoint_failed')
        throw error
      }

      generation.sourcePath = checkpoint.sourcePath
      generation.manifestHash = manifestHash(checkpoint.manifest)
      generation.objectCount = String(checkpoint.manifest.objectCount)
      generation.bytes = String(checkpoint.manifest.bytes)
      generation.manifest = Object.fromEntries(Object.entries(checkpoint.manifest))
      generation.state = WorkspaceGenerationState.CHECKPOINTED
      generation.errorCode = null
      await this.generationRepository.save(generation)

      let objectStoreCommitted = false
      let latestPublished = false
      try {
        generation.state = WorkspaceGenerationState.UPLOADING
        await this.generationRepository.save(generation)

        // The store receives only the immutable checkpoint. It must not walk the
        // live workspace or infer a generation from a watcher event.
        await input.store.putObjects(workspaceKey, checkpoint)
        await input.store.putManifest(workspaceKey, checkpoint.manifest)
        const readBack = await input.store.readManifest(workspaceKey, nextGeneration)
        assertManifestMatches(checkpoint.manifest, readBack)
        await input.store.putCommittedMarker(workspaceKey, checkpoint.manifest)
        objectStoreCommitted = true

        const expectedLatest = await input.store.getLatest(workspaceKey)
        const expectedLatestGeneration = expectedLatest === null ? null : BigInt(expectedLatest)
        latestPublished =
          expectedLatestGeneration !== null && expectedLatestGeneration >= BigInt(nextGeneration)
            ? true
            : await input.store.compareAndSetLatest(workspaceKey, expectedLatest, nextGeneration)

        generation.state = WorkspaceGenerationState.COMMITTED
        generation.committedAt = input.now ?? new Date()
        await this.generationRepository.save(generation)

        this.applyCommittedPlacementState({
          placement,
          generation: nextGeneration,
          latest: expectedLatest,
          latestPublished,
        })
        await this.placementRepository.save(placement)
        return {
          outcome: latestPublished ? 'committed' : 'committed_pending_latest',
          generation,
        }
      } catch {
        if (objectStoreCommitted) {
          generation.state = WorkspaceGenerationState.COMMITTED
          generation.errorCode = null
          generation.committedAt = generation.committedAt ?? input.now ?? new Date()
          try {
            await this.generationRepository.save(generation)
          } catch {
            // Keep the fixed error category below; the immutable object-store
            // commit remains the recovery source even if this write is ambiguous.
          }
          placement.dirty = true
          placement.replicationStatus = 'committed'
          try {
            await this.placementRepository.save(placement)
          } catch {
            // The reconciler will retry from the committed generation row.
          }
          throw new Error(FIXED_PERSIST_ERROR)
        }
        generation.state = WorkspaceGenerationState.FAILED
        generation.errorCode = FIXED_UPLOAD_ERROR
        await this.generationRepository.save(generation)
        placement.replicationStatus = 'failed'
        placement.dirty = true
        await this.placementRepository.save(placement)
        throw new Error(FIXED_UPLOAD_ERROR)
      }
    } finally {
      await this.releaseCheckpointLease(placement, checkpointLease)
    }
  }

  private async prepareGenerationIntent(
    placement: WorkspacePlacement,
    generation: string,
    existing: WorkspaceGeneration | null,
    now: Date,
  ): Promise<WorkspaceGeneration> {
    if (existing) {
      if (!existing.operationId) throw new ConflictException('generation_operation_missing')
      existing.state = WorkspaceGenerationState.CHECKPOINTING
      existing.errorCode = null
      existing.updatedAt = now
      return this.generationRepository.save(existing)
    }

    const intent = this.generationRepository.create({
      operationId: randomUUID(),
      placementId: placement.id,
      volumeId: placement.volumeId,
      sandboxId: placement.sandboxId,
      generation,
      state: WorkspaceGenerationState.CHECKPOINTING,
      sourcePath: `pending:${placement.id}:${generation}`,
      manifestHash: '0'.repeat(64),
      objectCount: '0',
      bytes: '0',
      manifest: {},
      errorCode: null,
      committedAt: null,
      createdAt: now,
      updatedAt: now,
    })
    return this.generationRepository.save(intent)
  }

  private async markGenerationFailed(
    generation: WorkspaceGeneration,
    placement: WorkspacePlacement,
    errorCode: string,
  ): Promise<void> {
    generation.state = WorkspaceGenerationState.FAILED
    generation.errorCode = errorCode
    await this.generationRepository.save(generation)
    placement.replicationStatus = 'failed'
    placement.dirty = true
    await this.placementRepository.save(placement)
  }

  private async acquireCheckpointLease(
    placement: WorkspacePlacement,
    now: Date,
  ): Promise<{ fenceEpoch: string; leaseOwner: string; leaseExpiresAt: string }> {
    if (!placement.ownerNodeId) throw new Error('recovery_required')
    if (placement.leaseOwner) {
      const leaseExpiresAt = placement.leaseExpiresAt ? new Date(placement.leaseExpiresAt) : null
      if (!leaseExpiresAt || !Number.isFinite(leaseExpiresAt.getTime())) {
        throw new ConflictException('workspace_lease_invalid')
      }
      if (leaseExpiresAt.getTime() > now.getTime()) {
        throw new ConflictException('workspace_checkpoint_writer_active')
      }
    }
    const fenceEpoch = Number(placement.fenceEpoch)
    if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch < 1) {
      throw new ConflictException('workspace_fence_invalid')
    }
    const leaseOwner = `generation-worker:${this.workerId}:${placement.id}`
    const leased = await this.workspacePlacementService.acquireWriterLease({
      placementId: placement.id,
      nodeId: placement.ownerNodeId,
      fenceEpoch,
      leaseOwner,
      now,
      leaseDurationMs: 10 * 60 * 1000,
    })
    if (!leased.leaseExpiresAt) throw new ConflictException('workspace_lease_invalid')
    const leaseExpiresAt = new Date(leased.leaseExpiresAt)
    if (!Number.isFinite(leaseExpiresAt.getTime())) throw new ConflictException('workspace_lease_invalid')
    return {
      fenceEpoch: String(leased.fenceEpoch),
      leaseOwner,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    }
  }

  private async releaseCheckpointLease(
    placement: WorkspacePlacement,
    lease: { fenceEpoch: string; leaseOwner: string },
  ): Promise<void> {
    try {
      await this.workspacePlacementService.releaseWriterLease({
        placementId: placement.id,
        nodeId: placement.ownerNodeId ?? '',
        fenceEpoch: Number(lease.fenceEpoch),
        leaseOwner: lease.leaseOwner,
      })
    } catch {
      // The lease has a bounded expiry; do not replace a durable upload result
      // with a release error or expose a database/provider error category.
    }
  }

  chooseRecoverySource(input: {
    ownerAvailable: boolean
    localGeneration: string
    cosGeneration: string
    latestCommittedGeneration: string | null
  }) {
    return chooseRecoverySource(input)
  }

  private applyCommittedPlacementState(input: {
    placement: WorkspacePlacement
    generation: string
    latest: string | null
    latestPublished: boolean
  }): void {
    const generation = BigInt(input.generation)
    const latest = input.latest === null ? generation : BigInt(input.latest)
    const observedGeneration = latest > generation ? latest : generation
    const currentLocalGeneration = BigInt(input.placement.localGeneration || '0')
    const currentCosGeneration = BigInt(input.placement.cosGeneration || '0')
    const localGeneration = currentLocalGeneration > observedGeneration ? currentLocalGeneration : observedGeneration
    const cosGeneration = currentCosGeneration > observedGeneration ? currentCosGeneration : observedGeneration

    input.placement.localGeneration = localGeneration.toString()
    input.placement.cosGeneration = cosGeneration.toString()
    input.placement.dirty = !input.latestPublished || localGeneration > cosGeneration
    input.placement.replicationStatus = input.placement.dirty ? 'committed' : 'durable'
  }

  private async publishCommittedLatest(input: {
    placement: WorkspacePlacement
    generation: string
    workspaceKey: string
    generationRow: WorkspaceGeneration
    store: GenerationObjectStore
  }): Promise<{ outcome: 'committed' | 'committed_pending_latest'; generation: WorkspaceGeneration }> {
    const latest = await input.store.getLatest(input.workspaceKey)
    if (latest !== null && !/^(0|[1-9][0-9]*)$/.test(latest)) {
      throw new Error('generation_latest_invalid')
    }

    let latestPublished = latest === input.generation
    if (!latestPublished && latest !== null && BigInt(latest) > BigInt(input.generation)) {
      // A concurrent worker has already published a newer committed generation.
      // Never move latest backwards; the local placement can safely observe it.
      latestPublished = true
    }
    if (!latestPublished) {
      latestPublished = await input.store.compareAndSetLatest(input.workspaceKey, latest, input.generation)
    }

    this.applyCommittedPlacementState({
      placement: input.placement,
      generation: input.generation,
      latest,
      latestPublished,
    })
    await this.placementRepository.save(input.placement)
    return {
      outcome: latestPublished ? 'committed' : 'committed_pending_latest',
      generation: input.generationRow,
    }
  }
}

function assertCheckpointIntegrity(
  checkpoint: ImmutableCheckpoint,
  volumeId: string,
  sandboxId: string,
  generation: string,
): void {
  const manifest = checkpoint.manifest
  if (
    manifest.formatVersion !== 1 ||
    manifest.volumeId !== volumeId ||
    manifest.sandboxId !== sandboxId ||
    manifest.generation !== generation ||
    !Number.isSafeInteger(manifest.objectCount) ||
    manifest.objectCount < 0 ||
    !Number.isSafeInteger(manifest.bytes) ||
    manifest.bytes < 0 ||
    !/^[a-f0-9]{64}$/.test(manifest.contentHash) ||
    typeof manifest.createdAt !== 'string' ||
    manifest.objectCount !== checkpoint.objects.length
  ) {
    throw new ConflictException('checkpoint_manifest_invalid')
  }

  let bytes = 0
  for (const object of checkpoint.objects) {
    const body = typeof object.body === 'string' ? Buffer.from(object.body) : Buffer.from(object.body)
    if (
      !isSafeObjectKey(object.key) ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      body.byteLength !== object.size ||
      !/^[a-f0-9]{64}$/.test(object.sha256) ||
      createHash('sha256').update(body).digest('hex') !== object.sha256 ||
      (object.mode !== undefined && (!Number.isSafeInteger(object.mode) || object.mode < 0 || object.mode > 0o777))
    ) {
      throw new ConflictException('checkpoint_manifest_invalid')
    }
    bytes += object.size
    if (!Number.isSafeInteger(bytes)) throw new ConflictException('checkpoint_manifest_invalid')
  }
  if (bytes !== manifest.bytes || checkpointContentHash(checkpoint.objects) !== manifest.contentHash) {
    throw new ConflictException('checkpoint_manifest_invalid')
  }
}

function isSafeObjectKey(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export class S3GenerationObjectStore implements GenerationObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly prefix = 'local-first',
  ) {
    if (!/^[A-Za-z0-9.!_-]{3,63}$/.test(bucket)) throw new Error('generation_bucket_invalid')
    if (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.startsWith('/') || prefix.includes('..')) {
      throw new Error('generation_prefix_invalid')
    }
  }

  async putObjects(workspaceKey: string, checkpoint: ImmutableCheckpoint): Promise<void> {
    this.assertWorkspaceKey(workspaceKey)
    for (const object of checkpoint.objects) {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: buildGenerationObjectKey(workspaceKey, checkpoint.generation, object.key),
          Body: object.body,
          ContentLength: object.size,
          Metadata: { sha256: object.sha256 },
        }),
      )
    }
  }

  async putManifest(workspaceKey: string, manifest: GenerationManifest): Promise<void> {
    const key = this.generationKey(workspaceKey, manifest.generation, GENERATION_MANIFEST_NAME)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify(manifest),
        ContentType: 'application/json',
      }),
    )
  }

  async readManifest(workspaceKey: string, generation: string): Promise<GenerationManifest> {
    const key = this.generationKey(workspaceKey, generation, GENERATION_MANIFEST_NAME)
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    )
    const text = await response.Body?.transformToString()
    if (!text) throw new Error('generation_manifest_missing')
    return JSON.parse(text) as GenerationManifest
  }

  async putCommittedMarker(workspaceKey: string, manifest: GenerationManifest): Promise<void> {
    const key = this.generationKey(workspaceKey, manifest.generation, GENERATION_COMMIT_MARKER)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify({ generation: manifest.generation, manifestHash: manifestHash(manifest) }),
        ContentType: 'application/json',
      }),
    )
  }

  async getLatest(workspaceKey: string): Promise<string | null> {
    this.assertWorkspaceKey(workspaceKey)
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${workspaceKey}/${GENERATION_LATEST_NAME}`,
        }),
      )
      const text = await response.Body?.transformToString()
      if (!text) return null
      const value = JSON.parse(text) as { generation?: unknown }
      if (typeof value.generation !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.generation)) {
        throw new Error('generation_latest_invalid')
      }
      const markerResponse = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: this.generationKey(workspaceKey, value.generation, GENERATION_COMMIT_MARKER),
        }),
      )
      const markerText = await markerResponse.Body?.transformToString()
      if (!markerText) throw new Error('generation_latest_invalid')
      const marker = JSON.parse(markerText) as { generation?: unknown; manifestHash?: unknown }
      if (
        marker.generation !== value.generation ||
        typeof marker.manifestHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(marker.manifestHash)
      ) {
        throw new Error('generation_latest_invalid')
      }
      const manifest = await this.readManifest(workspaceKey, value.generation)
      if (manifest.generation !== value.generation || manifestHash(manifest) !== marker.manifestHash) {
        throw new Error('generation_latest_invalid')
      }
      return value.generation
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }

  async compareAndSetLatest(workspaceKey: string, expected: string | null, generation: string): Promise<boolean> {
    this.assertWorkspaceKey(workspaceKey)
    if (!/^(0|[1-9][0-9]*)$/.test(generation)) throw new BadRequestException('generation_invalid')
    const latestKey = `${workspaceKey}/${GENERATION_LATEST_NAME}`
    let etag: string | undefined

    // A latest pointer is a recovery source only after the generation's
    // immutable commit marker exists. Verify the expected pointer value and
    // its current ETag in the same read sequence; If-Match then closes the
    // concurrent-writer race between this read and the publish.
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: this.generationKey(workspaceKey, generation, GENERATION_COMMIT_MARKER),
        }),
      )
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }

    try {
      const latest = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: latestKey,
        }),
      )
      const latestText = await latest.Body?.transformToString()
      if (!latestText) return false
      let latestValue: { generation?: unknown }
      try {
        latestValue = JSON.parse(latestText) as { generation?: unknown }
      } catch {
        return false
      }
      if (latestValue.generation !== expected) return false
      const response = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: latestKey,
        }),
      )
      etag = response.ETag
    } catch (error) {
      if (!isNotFound(error)) throw error
      if (expected !== null) return false
    }

    const input: Record<string, unknown> = {
      Bucket: this.bucket,
      Key: latestKey,
      Body: JSON.stringify({ generation }),
      ContentType: 'application/json',
    }
    if (etag) input.IfMatch = etag
    else input.IfNoneMatch = '*'
    try {
      await this.client.send(new PutObjectCommand(input as never))
      return true
    } catch (error) {
      if (isPreconditionFailure(error)) return false
      throw error
    }
  }

  private generationKey(workspaceKey: string, generation: string, name: string): string {
    this.assertWorkspaceKey(workspaceKey)
    return buildGenerationObjectKey(workspaceKey, generation, name)
  }

  private assertWorkspaceKey(workspaceKey: string): void {
    if (!workspaceKey.startsWith(`${this.prefix}/`)) throw new BadRequestException('generation_prefix_mismatch')
  }
}

function isNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ('$metadata' in error || 'name' in error) &&
      ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ||
        (error as { name?: string }).name === 'NoSuchKey' ||
        (error as { name?: string }).name === 'NotFound'),
  )
}

function isPreconditionFailure(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412 ||
        (error as { name?: string }).name === 'PreconditionFailed'),
  )
}
