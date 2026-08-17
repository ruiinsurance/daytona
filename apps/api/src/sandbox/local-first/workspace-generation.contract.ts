/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash } from 'node:crypto'
import { BadRequestException } from '@nestjs/common'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/

export const GENERATION_COMMIT_MARKER = '_COMMITTED'
export const GENERATION_MANIFEST_NAME = 'manifest.json'
export const GENERATION_LATEST_NAME = 'latest'

export type RecoverySource = 'local' | 'cos' | 'recovery_required'

export interface GenerationManifest {
  formatVersion: 1
  volumeId: string
  sandboxId: string
  generation: string
  objectCount: number
  bytes: number
  contentHash: string
  createdAt: string
}

export interface CheckpointObject {
  key: string
  body: string | Uint8Array
  size: number
  sha256: string
  mode?: number
}

export interface ImmutableCheckpoint {
  sourcePath: string
  generation: string
  manifest: GenerationManifest
  objects: readonly CheckpointObject[]
}

export interface ImmutableCheckpointSource {
  create(input: {
    volumeId: string
    sandboxId: string
    sourcePath: string
    nextGeneration: string
    ownerNodeId?: string
    operationId?: string
    fenceEpoch?: string
    leaseOwner?: string
    leaseExpiresAt?: string
  }): Promise<ImmutableCheckpoint>
}

export interface GenerationObjectStore {
  putObjects(workspaceKey: string, checkpoint: ImmutableCheckpoint): Promise<void>
  putManifest(workspaceKey: string, manifest: GenerationManifest): Promise<void>
  readManifest(workspaceKey: string, generation: string): Promise<GenerationManifest>
  putCommittedMarker(workspaceKey: string, manifest: GenerationManifest): Promise<void>
  getLatest(workspaceKey: string): Promise<string | null>
  compareAndSetLatest(workspaceKey: string, expected: string | null, generation: string): Promise<boolean>
}

export function buildWorkspaceGenerationKey(volumeId: string, sandboxId: string, prefix = 'local-first'): string {
  assertUuid(volumeId, 'volume_id_invalid')
  assertUuid(sandboxId, 'sandbox_id_invalid')
  assertSafePrefix(prefix)
  return `${prefix}/volumes/${volumeId}/sandboxes/${sandboxId}/generations`
}

export function buildGenerationObjectKey(workspaceKey: string, generation: string, name: string): string {
  assertSafePrefix(workspaceKey)
  assertDecimal(generation, 'generation_invalid')
  if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\u0000')) {
    throw new BadRequestException('generation_object_key_invalid')
  }
  const parts = name.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new BadRequestException('generation_object_key_invalid')
  }
  return `${workspaceKey}/${generation}/${name}`
}

export function manifestHash(manifest: GenerationManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex')
}

export function checkpointContentHash(objects: readonly CheckpointObject[]): string {
  const digest = createHash('sha256')
  for (const object of [...objects].sort((left, right) => left.key.localeCompare(right.key))) {
    digest.update(object.key)
    digest.update(object.sha256)
  }
  return digest.digest('hex')
}

export function assertManifestMatches(expected: GenerationManifest, actual: GenerationManifest): void {
  if (
    expected.formatVersion !== actual.formatVersion
    || expected.volumeId !== actual.volumeId
    || expected.sandboxId !== actual.sandboxId
    || expected.generation !== actual.generation
    || expected.objectCount !== actual.objectCount
    || expected.bytes !== actual.bytes
    || expected.contentHash !== actual.contentHash
    || expected.createdAt !== actual.createdAt
    || manifestHash(expected) !== manifestHash(actual)
  ) {
    throw new Error('generation_manifest_mismatch')
  }
}

export function chooseRecoverySource(input: {
  ownerAvailable: boolean
  localGeneration: string
  cosGeneration: string
  latestCommittedGeneration: string | null
}): RecoverySource {
  assertDecimal(input.localGeneration, 'local_generation_invalid')
  assertDecimal(input.cosGeneration, 'cos_generation_invalid')
  if (input.ownerAvailable) return 'local'

  const local = BigInt(input.localGeneration)
  const cos = BigInt(input.cosGeneration)
  if (
    input.latestCommittedGeneration !== null
    && DECIMAL_RE.test(input.latestCommittedGeneration)
    && BigInt(input.latestCommittedGeneration) >= local
    && cos >= local
  ) {
    return 'cos'
  }
  return 'recovery_required'
}

export function assertDecimal(value: string, code: string): void {
  if (!DECIMAL_RE.test(value)) throw new BadRequestException(code)
}

export function assertUuid(value: string, code: string): void {
  if (!UUID_RE.test(value)) throw new BadRequestException(code)
}

function assertSafePrefix(value: string): void {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\u0000')) {
    throw new BadRequestException('generation_prefix_invalid')
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new BadRequestException('generation_prefix_invalid')
  }
}
