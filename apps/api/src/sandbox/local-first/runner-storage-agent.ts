/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Injectable } from '@nestjs/common'
import { InjectRepository } from '@nestjs/typeorm'
import { createHash } from 'node:crypto'
import { Repository } from 'typeorm'
import { Runner } from '../entities/runner.entity'
import { StorageNode } from '../entities/storage-node.entity'
import {
  checkpointContentHash,
  type CheckpointObject,
  type GenerationManifest,
  type ImmutableCheckpoint,
  type ImmutableCheckpointSource,
} from './workspace-generation.contract'
import { manifestHash } from './workspace-generation.contract'
import { WorkspacePlacementService } from '../services/workspace-placement.service'
import type { MoveRuntimeAdapter, MoveRuntimeInput } from '../services/workspace-move.service'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/
const STORAGE_AGENT_TIMEOUT_MS = 30_000

interface AgentLease {
  operationId: string
  fenceEpoch: string
  leaseOwner: string
  leaseExpiresAt: string
}

interface CheckpointResponse {
  generation: string
  manifest: GenerationManifest
  objects: Array<{
    key: string
    body: string
    size: number
    sha256: string
    mode?: number
  }>
}

interface VerifyResponse {
  generation: string
  manifestHash: string
}

@Injectable()
export class RunnerStorageAgentClient {
  constructor(
    @InjectRepository(StorageNode)
    private readonly storageNodeRepository: Repository<StorageNode>,
    @InjectRepository(Runner)
    private readonly runnerRepository: Repository<Runner>,
  ) {}

  async checkpoint(input: {
    nodeId: string
    volumeId: string
    sandboxId: string
    generation: string
    lease: AgentLease
  }): Promise<ImmutableCheckpoint> {
    return this.normaliseCheckpoint(
      await this.request<CheckpointResponse>(input.nodeId, '/storage/workspaces/checkpoint', {
        operationId: input.lease.operationId,
        volumeId: input.volumeId,
        sandboxId: input.sandboxId,
        nodeId: input.nodeId,
        generation: input.generation,
        fenceEpoch: input.lease.fenceEpoch,
        leaseOwner: input.lease.leaseOwner,
        leaseExpiresAt: input.lease.leaseExpiresAt,
      }),
      input.nodeId,
      input.volumeId,
      input.sandboxId,
      input.generation,
    )
  }

  async export(input: {
    nodeId: string
    volumeId: string
    sandboxId: string
    generation: string
    lease: AgentLease
  }): Promise<ImmutableCheckpoint> {
    return this.normaliseCheckpoint(
      await this.request<CheckpointResponse>(input.nodeId, '/storage/workspaces/export', {
        operationId: input.lease.operationId,
        volumeId: input.volumeId,
        sandboxId: input.sandboxId,
        nodeId: input.nodeId,
        generation: input.generation,
        fenceEpoch: input.lease.fenceEpoch,
        leaseOwner: input.lease.leaseOwner,
        leaseExpiresAt: input.lease.leaseExpiresAt,
      }),
      input.nodeId,
      input.volumeId,
      input.sandboxId,
      input.generation,
    )
  }

  async import(input: {
    nodeId: string
    volumeId: string
    sandboxId: string
    checkpoint: ImmutableCheckpoint
    lease: AgentLease
  }): Promise<void> {
    await this.request(input.nodeId, '/storage/workspaces/import', {
      operationId: input.lease.operationId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      generation: input.checkpoint.generation,
      fenceEpoch: input.lease.fenceEpoch,
      leaseOwner: input.lease.leaseOwner,
      leaseExpiresAt: input.lease.leaseExpiresAt,
      manifest: input.checkpoint.manifest,
      objects: input.checkpoint.objects.map((object) => ({
        key: object.key,
        body: Buffer.from(object.body).toString('base64'),
        size: object.size,
        sha256: object.sha256,
        mode: object.mode,
      })),
    })
  }

  async verify(input: {
    nodeId: string
    volumeId: string
    sandboxId: string
    checkpoint: ImmutableCheckpoint
    lease: AgentLease
  }): Promise<VerifyResponse> {
    const response = await this.request<VerifyResponse>(input.nodeId, '/storage/workspaces/verify', {
      operationId: input.lease.operationId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      generation: input.checkpoint.generation,
      fenceEpoch: input.lease.fenceEpoch,
      leaseOwner: input.lease.leaseOwner,
      leaseExpiresAt: input.lease.leaseExpiresAt,
      manifest: input.checkpoint.manifest,
    })
    if (
      !response ||
      response.generation !== input.checkpoint.generation ||
      typeof response.manifestHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(response.manifestHash)
    ) {
      throw new Error('storage_agent_payload_invalid')
    }
    return response
  }

  async quiesce(input: { nodeId: string; volumeId: string; sandboxId: string; lease: AgentLease }): Promise<void> {
    await this.request(input.nodeId, '/storage/workspaces/quiesce', {
      operationId: input.lease.operationId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      fenceEpoch: input.lease.fenceEpoch,
      leaseOwner: input.lease.leaseOwner,
      leaseExpiresAt: input.lease.leaseExpiresAt,
    })
  }

  async fence(input: { nodeId: string; volumeId: string; sandboxId: string; lease: AgentLease }): Promise<void> {
    await this.request(input.nodeId, '/storage/workspaces/fence', {
      operationId: input.lease.operationId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      fenceEpoch: input.lease.fenceEpoch,
      leaseOwner: input.lease.leaseOwner,
      leaseExpiresAt: input.lease.leaseExpiresAt,
    })
  }

  async start(input: { nodeId: string; volumeId: string; sandboxId: string; lease: AgentLease }): Promise<void> {
    await this.request(input.nodeId, '/storage/workspaces/start', {
      operationId: input.lease.operationId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      fenceEpoch: input.lease.fenceEpoch,
      leaseOwner: input.lease.leaseOwner,
      leaseExpiresAt: input.lease.leaseExpiresAt,
    })
  }

  async retain(input: {
    nodeId: string
    volumeId: string
    sandboxId: string
    generation: string
    lease: AgentLease
  }): Promise<void> {
    await this.request(input.nodeId, '/storage/workspaces/retain', {
      operationId: input.lease.operationId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      nodeId: input.nodeId,
      generation: input.generation,
      fenceEpoch: input.lease.fenceEpoch,
      leaseOwner: input.lease.leaseOwner,
      leaseExpiresAt: input.lease.leaseExpiresAt,
    })
  }

  private async request<T>(nodeId: string, path: string, body: unknown): Promise<T> {
    const runner = await this.loadRunner(nodeId)
    let endpoint: URL
    try {
      if (!runner.apiUrl) throw new Error('runner_url_missing')
      const base = new URL(runner.apiUrl)
      if (base.protocol !== 'http:' && base.protocol !== 'https:') throw new Error('runner_url_invalid')
      endpoint = new URL(path.replace(/^\/+/, ''), `${base.toString().replace(/\/$/, '')}/`)
    } catch {
      throw new Error('storage_agent_runner_unavailable')
    }
    if (!runner.apiKey) throw new Error('storage_agent_runner_unavailable')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), STORAGE_AGENT_TIMEOUT_MS)
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${runner.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      if (!response.ok) {
        let code = `storage_agent_http_${response.status}`
        try {
          const errorBody = (await response.json()) as { code?: unknown }
          if (typeof errorBody.code === 'string' && /^[a-z0-9_]+$/.test(errorBody.code)) code = errorBody.code
        } catch {
          // Keep the fixed status category when the Runner response is not JSON.
        }
        throw new Error(code)
      }
      try {
        return (await response.json()) as T
      } catch {
        throw new Error('storage_agent_response_invalid')
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /^storage_agent_(?:http_|response_|runner_|payload_|request_)/.test(error.message)
      ) {
        throw error
      }
      throw new Error(controller.signal.aborted ? 'storage_agent_timeout' : 'storage_agent_request_failed')
    } finally {
      clearTimeout(timeout)
    }
  }

  private async loadRunner(nodeId: string): Promise<Runner> {
    assertUuid(nodeId, 'storage_node_id_invalid')
    const node = await this.storageNodeRepository.findOne({ where: { nodeId } })
    if (!node) throw new Error('storage_agent_runner_unavailable')
    const runner = await this.runnerRepository.findOne({ where: { id: node.runnerId } })
    if (!runner) throw new Error('storage_agent_runner_unavailable')
    return runner
  }

  private normaliseCheckpoint(
    raw: CheckpointResponse,
    nodeId: string,
    volumeId: string,
    sandboxId: string,
    generation: string,
  ): ImmutableCheckpoint {
    if (!raw || typeof raw !== 'object' || !isRecord(raw.manifest) || !Array.isArray(raw.objects)) {
      throw new Error('storage_agent_payload_invalid')
    }
    const manifest = raw.manifest as GenerationManifest
    if (
      manifest.formatVersion !== 1 ||
      !UUID_RE.test(manifest.volumeId) ||
      !UUID_RE.test(manifest.sandboxId) ||
      !DECIMAL_RE.test(manifest.generation) ||
      manifest.volumeId !== volumeId ||
      manifest.sandboxId !== sandboxId ||
      manifest.generation !== generation ||
      raw.generation !== manifest.generation ||
      !Number.isSafeInteger(manifest.objectCount) ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.objectCount < 0 ||
      manifest.bytes < 0
    ) {
      throw new Error('storage_agent_payload_invalid')
    }
    const objects: CheckpointObject[] = []
    for (const rawObject of raw.objects) {
      if (!isRecord(rawObject) || typeof rawObject.key !== 'string' || typeof rawObject.body !== 'string') {
        throw new Error('storage_agent_payload_invalid')
      }
      const body = Buffer.from(rawObject.body, 'base64')
      const size = rawObject.size
      const sha256 = rawObject.sha256
      if (
        !isSafeObjectKey(rawObject.key) ||
        !Number.isSafeInteger(size) ||
        size < 0 ||
        body.byteLength !== size ||
        typeof sha256 !== 'string' ||
        !/^[a-f0-9]{64}$/.test(sha256) ||
        createHash('sha256').update(body).digest('hex') !== sha256
      ) {
        throw new Error('storage_agent_payload_invalid')
      }
      objects.push({
        key: rawObject.key,
        body,
        size,
        sha256,
        mode: typeof rawObject.mode === 'number' && Number.isSafeInteger(rawObject.mode) ? rawObject.mode : undefined,
      })
    }
    if (
      objects.length !== manifest.objectCount ||
      objects.reduce((total, object) => total + object.size, 0) !== manifest.bytes ||
      checkpointContentHash(objects) !== manifest.contentHash
    ) {
      throw new Error('storage_agent_payload_invalid')
    }
    return {
      sourcePath: `runner-local-first:${nodeId}`,
      generation: manifest.generation,
      manifest,
      objects,
    }
  }
}

@Injectable()
export class RunnerStorageAgentCheckpointSource implements ImmutableCheckpointSource {
  constructor(private readonly client: RunnerStorageAgentClient) {}

  async create(input: {
    volumeId: string
    sandboxId: string
    sourcePath: string
    nextGeneration: string
    ownerNodeId?: string
    operationId?: string
    fenceEpoch?: string
    leaseOwner?: string
    leaseExpiresAt?: string
  }): Promise<ImmutableCheckpoint> {
    if (!input.ownerNodeId) throw new Error('storage_agent_owner_missing')
    if (!input.operationId || !input.fenceEpoch || !input.leaseOwner || !input.leaseExpiresAt) {
      throw new Error('storage_agent_lease_missing')
    }
    return this.client.checkpoint({
      nodeId: input.ownerNodeId,
      volumeId: input.volumeId,
      sandboxId: input.sandboxId,
      generation: input.nextGeneration,
      lease: buildLease({
        operationId: input.operationId,
        fenceEpoch: input.fenceEpoch,
        leaseOwner: input.leaseOwner,
        leaseExpiresAt: input.leaseExpiresAt,
      }),
    })
  }
}

@Injectable()
export class RunnerStorageAgentMoveRuntime implements MoveRuntimeAdapter {
  private readonly checkpoints = new Map<string, ImmutableCheckpoint>()

  constructor(
    private readonly client: RunnerStorageAgentClient,
    private readonly workspacePlacementService: WorkspacePlacementService,
  ) {}

  async quiesce(input: MoveRuntimeInput): Promise<void> {
    await this.client.quiesce({
      nodeId: input.operation.sourceNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      lease: this.lease(input, input.fenceEpoch),
    })
  }

  async checkpoint(input: MoveRuntimeInput): Promise<{ generation: string }> {
    const generation = input.checkpointGeneration
    if (!generation || !DECIMAL_RE.test(generation)) throw new Error('move_checkpoint_generation_missing')
    const checkpoint = await this.client.checkpoint({
      nodeId: input.operation.sourceNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      generation,
      lease: this.lease(input, input.operation.expectedFenceEpoch),
    })
    this.checkpoints.set(input.operation.id, checkpoint)
    return { generation: checkpoint.generation }
  }

  async copy(input: MoveRuntimeInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(input)
    await this.client.import({
      nodeId: input.operation.targetNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      checkpoint,
      lease: this.lease(input, input.operation.expectedFenceEpoch),
    })
  }

  async verifyTarget(input: MoveRuntimeInput): Promise<{ generation: string; manifestHash: string }> {
    const checkpoint = await this.loadCheckpoint(input)
    const result = await this.client.verify({
      nodeId: input.operation.targetNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      checkpoint,
      lease: this.lease(input, input.operation.expectedFenceEpoch),
    })
    const expectedHash = manifestHash(checkpoint.manifest)
    if (result.generation !== checkpoint.generation || result.manifestHash !== expectedHash) {
      throw new Error('storage_agent_target_manifest_mismatch')
    }
    return { generation: checkpoint.generation, manifestHash: expectedHash }
  }

  async startTarget(input: MoveRuntimeInput): Promise<void> {
    const fenceEpoch = Number(input.fenceEpoch)
    if (!Number.isSafeInteger(fenceEpoch) || fenceEpoch < 1) throw new Error('workspace_fence_invalid')
    await this.client.fence({
      nodeId: input.operation.sourceNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      lease: this.lease(input, String(fenceEpoch)),
    })
    const placement = await this.workspacePlacementService.acquireWriterLease({
      placementId: input.operation.placementId,
      nodeId: input.operation.targetNodeId,
      fenceEpoch,
      leaseOwner: input.operation.leaseOwner ?? '',
    })
    if (!placement.leaseExpiresAt) throw new Error('workspace_lease_expired')
    await this.client.start({
      nodeId: input.operation.targetNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      lease: this.lease(input, String(fenceEpoch), placement.leaseExpiresAt.toISOString()),
    })
  }

  async retainSource(input: MoveRuntimeInput): Promise<void> {
    const checkpoint = await this.loadCheckpoint(input)
    await this.client.retain({
      nodeId: input.operation.sourceNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      generation: checkpoint.generation,
      lease: this.lease(input, input.fenceEpoch),
    })
    this.checkpoints.delete(input.operation.id)
  }

  private async loadCheckpoint(input: MoveRuntimeInput): Promise<ImmutableCheckpoint> {
    const cached = this.checkpoints.get(input.operation.id)
    if (cached) return cached
    if (!input.checkpointGeneration) throw new Error('move_checkpoint_missing')
    const checkpoint = await this.client.export({
      nodeId: input.operation.sourceNodeId,
      volumeId: input.operation.volumeId,
      sandboxId: input.operation.sandboxId,
      generation: input.checkpointGeneration,
      lease: this.lease(input, input.operation.expectedFenceEpoch),
    })
    this.checkpoints.set(input.operation.id, checkpoint)
    return checkpoint
  }

  private lease(input: MoveRuntimeInput, fenceEpoch: string, leaseExpiresAt?: string): AgentLease {
    if (!input.operation.leaseOwner) throw new Error('workspace_lease_missing')
    return buildLease({
      operationId: input.operation.id,
      fenceEpoch,
      leaseOwner: input.operation.leaseOwner,
      leaseExpiresAt,
    })
  }
}

function buildLease(input: Omit<AgentLease, 'leaseExpiresAt'> & { leaseExpiresAt?: string }): AgentLease {
  const leaseExpiresAt = input.leaseExpiresAt ?? new Date(Date.now() + 60_000).toISOString()
  if (!UUID_RE.test(input.operationId) || !DECIMAL_RE.test(input.fenceEpoch) || !input.leaseOwner || !leaseExpiresAt) {
    throw new Error('workspace_lease_invalid')
  }
  return { ...input, leaseExpiresAt }
}

function assertUuid(value: string, code: string): void {
  if (!UUID_RE.test(value)) throw new Error(code)
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function isSafeObjectKey(value: string): boolean {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) return false
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}
