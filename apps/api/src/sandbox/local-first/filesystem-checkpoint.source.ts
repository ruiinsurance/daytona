/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import {
  checkpointContentHash,
  compareCheckpointObjectKeys,
  ImmutableCheckpoint,
  ImmutableCheckpointSource,
  CheckpointObject,
  GenerationManifest,
  assertDecimal,
  assertUuid,
} from './workspace-generation.contract'

export class FilesystemImmutableCheckpointSource implements ImmutableCheckpointSource {
  constructor(private readonly checkpointRoot: string) {
    if (!checkpointRoot || !checkpointRoot.startsWith('/') || resolve(checkpointRoot) !== checkpointRoot) {
      throw new Error('checkpoint_root_invalid')
    }
  }

  async create(input: {
    volumeId: string
    sandboxId: string
    sourcePath: string
    nextGeneration: string
  }): Promise<ImmutableCheckpoint> {
    assertUuid(input.volumeId, 'volume_id_invalid')
    assertUuid(input.sandboxId, 'sandbox_id_invalid')
    assertDecimal(input.nextGeneration, 'generation_invalid')
    if (!input.sourcePath || !input.sourcePath.startsWith('/') || resolve(input.sourcePath) !== input.sourcePath) {
      throw new Error('checkpoint_source_path_invalid')
    }

    const sourceLinkInfo = await lstat(input.sourcePath)
    if (sourceLinkInfo.isSymbolicLink()) throw new Error('checkpoint_symlink_rejected')
    const sourcePath = await realpath(input.sourcePath)
    const sourceStat = await lstat(sourcePath)
    if (!sourceStat.isDirectory()) throw new Error('checkpoint_source_not_directory')
    await assertNoSymlinks(sourcePath)

    const finalPath = join(this.checkpointRoot, 'checkpoints', input.volumeId, input.sandboxId, input.nextGeneration)
    const manifestPath = join(finalPath, '.checkpoint-manifest.json')
    try {
      const persistedManifest = JSON.parse(await readFile(manifestPath, 'utf8')) as GenerationManifest
      if (
        persistedManifest.volumeId !== input.volumeId ||
        persistedManifest.sandboxId !== input.sandboxId ||
        persistedManifest.generation !== input.nextGeneration
      ) {
        throw new Error('checkpoint_manifest_mismatch')
      }
      return this.loadCheckpoint(finalPath, persistedManifest)
    } catch (error) {
      if (!isMissing(error)) throw error
    }

    await mkdir(join(this.checkpointRoot, 'checkpoints', input.volumeId, input.sandboxId), {
      recursive: true,
      mode: 0o750,
    })
    const stagingPath = `${finalPath}.staging-${randomUUID()}`
    await cp(sourcePath, stagingPath, { recursive: true, force: false, verbatimSymlinks: true })
    try {
      await assertNoSymlinks(stagingPath)
      const objects = await collectObjects(stagingPath)
      let bytes = 0
      for (const object of objects) {
        bytes += object.size
      }
      const manifest: GenerationManifest = {
        formatVersion: 1,
        volumeId: input.volumeId,
        sandboxId: input.sandboxId,
        generation: input.nextGeneration,
        objectCount: objects.length,
        bytes,
        contentHash: checkpointContentHash(objects),
        createdAt: new Date().toISOString(),
      }
      await writeFile(join(stagingPath, '.checkpoint-manifest.json'), JSON.stringify(manifest), { mode: 0o640 })
      await rename(stagingPath, finalPath)
      await makeReadOnly(finalPath)
      return {
        sourcePath: finalPath,
        generation: input.nextGeneration,
        manifest,
        objects: await collectObjects(finalPath),
      }
    } catch (error) {
      await removeStaging(stagingPath)
      throw error
    }
  }

  private async loadCheckpoint(path: string, manifest: GenerationManifest): Promise<ImmutableCheckpoint> {
    const objects = await collectObjects(path)
    const bytes = objects.reduce((sum, object) => sum + object.size, 0)
    if (
      manifest.formatVersion !== 1 ||
      !Number.isSafeInteger(manifest.objectCount) ||
      manifest.objectCount < 0 ||
      !Number.isSafeInteger(manifest.bytes) ||
      manifest.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(manifest.contentHash) ||
      objects.length !== manifest.objectCount ||
      bytes !== manifest.bytes ||
      checkpointContentHash(objects) !== manifest.contentHash
    ) {
      throw new Error('checkpoint_manifest_mismatch')
    }
    return { sourcePath: path, generation: manifest.generation, manifest, objects }
  }
}

async function makeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  const { chmod } = await import('node:fs/promises')
  await chmod(join(root, '.checkpoint-manifest.json'), 0o440)
  for (const entry of entries) {
    const fullPath = join(root, entry.name)
    if (entry.isDirectory()) {
      await makeReadOnly(fullPath)
    } else if (entry.isFile()) {
      await chmod(fullPath, 0o440)
    }
  }
  await chmod(root, 0o550)
}

async function collectObjects(root: string): Promise<CheckpointObject[]> {
  const objects: CheckpointObject[] = []
  await walk(root, root, objects)
  objects.sort(compareCheckpointObjectKeys)
  return objects
}

async function walk(root: string, current: string, objects: CheckpointObject[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '.checkpoint-manifest.json') continue
    const fullPath = join(current, entry.name)
    if (entry.isSymbolicLink()) throw new Error('checkpoint_symlink_rejected')
    if (entry.isDirectory()) {
      await walk(root, fullPath, objects)
      continue
    }
    if (!entry.isFile()) throw new Error('checkpoint_special_file_rejected')
    const body = await readFile(fullPath)
    objects.push({
      key: relative(root, fullPath).split('\\').join('/'),
      body,
      size: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      mode: (await lstat(fullPath)).mode & 0o777,
    })
  }
}

async function assertNoSymlinks(root: string): Promise<void> {
  const info = await lstat(root)
  if (info.isSymbolicLink()) throw new Error('checkpoint_symlink_rejected')
  if (!info.isDirectory()) return
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error('checkpoint_symlink_rejected')
    if (entry.isDirectory()) await assertNoSymlinks(join(root, entry.name))
  }
}

async function removeStaging(path: string): Promise<void> {
  try {
    const { rm } = await import('node:fs/promises')
    await rm(path, { recursive: true, force: true })
  } catch {
    // Retaining a failed staging directory is safer than masking the original
    // checkpoint failure; operators can inspect it under the retained root.
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === 'ENOENT',
  )
}
