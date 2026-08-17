import { chmod, mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FilesystemImmutableCheckpointSource } from './filesystem-checkpoint.source'

const VOLUME_ID = '11111111-1111-4111-8111-111111111111'
const SANDBOX_ID = '22222222-2222-4222-8222-222222222222'

describe('FilesystemImmutableCheckpointSource', () => {
  it('publishes a static retained checkpoint and reuses it on retry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daytona-checkpoint-'))
    try {
      const source = join(root, 'workspace')
      await mkdir(source, { recursive: true })
      await writeFile(join(source, 'state.db'), 'before')
      const checkpointSource = new FilesystemImmutableCheckpointSource(join(root, 'storage'))

      const first = await checkpointSource.create({
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        sourcePath: source,
        nextGeneration: '1',
      })
      await writeFile(join(source, 'state.db'), 'after')
      const second = await checkpointSource.create({
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        sourcePath: source,
        nextGeneration: '1',
      })

      expect(first.manifest.objectCount).toBe(1)
      expect(Buffer.from(first.objects[0].body).toString()).toBe('before')
      expect(Buffer.from(second.objects[0].body).toString()).toBe('before')
      expect(second.sourcePath).toBe(first.sourcePath)
    } finally {
      await makeTreeWritable(root)
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects symlinked workspace input before copying', async () => {
    const root = await mkdtemp(join(tmpdir(), 'daytona-checkpoint-symlink-'))
    try {
      await mkdir(root, { recursive: true })
      const outside = join(root, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, 'secret'), 'content')
      const source = join(root, 'workspace')
      await symlink(outside, source)
      const checkpointSource = new FilesystemImmutableCheckpointSource(join(root, 'storage'))

      await expect(checkpointSource.create({
        volumeId: VOLUME_ID,
        sandboxId: SANDBOX_ID,
        sourcePath: source,
        nextGeneration: '1',
      })).rejects.toThrow('checkpoint_symlink_rejected')
    } finally {
      await makeTreeWritable(root)
      await rm(root, { recursive: true, force: true })
    }
  })
})

async function makeTreeWritable(path: string): Promise<void> {
  try {
    await chmod(path, 0o750)
  } catch {
    return
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await makeTreeWritable(child)
    else await chmod(child, 0o640)
  }
}
