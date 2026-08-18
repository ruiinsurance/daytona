import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { checkpointContentHash } from './workspace-generation.contract'

describe('workspace generation contract', () => {
  it('uses bytewise object-key ordering shared with the Runner storage agent', () => {
    const objects = [
      { key: 'dir-00/file-0000.dat', body: 'body', size: 4, sha256: 'b'.repeat(64) },
      { key: 'README.test-marker', body: 'body', size: 4, sha256: 'a'.repeat(64) },
    ]
    const expected = createHash('sha256')
      .update('README.test-marker')
      .update('a'.repeat(64))
      .update('dir-00/file-0000.dat')
      .update('b'.repeat(64))
      .digest('hex')

    expect(checkpointContentHash(objects)).toBe(expected)
  })
})
