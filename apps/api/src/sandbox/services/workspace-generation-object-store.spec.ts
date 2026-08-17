import { describe, expect, it, vi } from 'vitest'
import { buildWorkspaceGenerationKey } from '../local-first/workspace-generation.contract'
import { S3GenerationObjectStore } from './workspace-generation.service'

const VOLUME_ID = '11111111-1111-4111-8111-111111111111'
const SANDBOX_ID = '22222222-2222-4222-8222-222222222222'

function notFound() {
  return { name: 'NotFound', $metadata: { httpStatusCode: 404 } }
}

describe('S3GenerationObjectStore', () => {
  it('does not publish latest when the immutable commit marker is absent', async () => {
    const send = vi.fn().mockRejectedValue(notFound())
    const store = new S3GenerationObjectStore({ send } as any, 'test-bucket', 'tenant/local-first')
    const workspaceKey = buildWorkspaceGenerationKey(VOLUME_ID, SANDBOX_ID, 'tenant/local-first')

    await expect(store.compareAndSetLatest(workspaceKey, null, '3')).resolves.toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].input.Key).toContain('/3/_COMMITTED')
  })

  it('checks the current pointer value before If-Match/If-None-Match publish', async () => {
    const send = vi.fn().mockImplementation(async (command: { input: Record<string, unknown> }) => {
      const key = String(command.input.Key)
      if (key.endsWith('/2/_COMMITTED')) return {}
      if (key.endsWith('/latest')) {
        if (command.input.Bucket && command.input.Body === undefined) {
          return {
            Body: { transformToString: async () => JSON.stringify({ generation: '1' }) },
            ETag: 'etag-1',
          }
        }
      }
      return {}
    })
    const store = new S3GenerationObjectStore({ send } as any, 'test-bucket', 'tenant/local-first')
    const workspaceKey = buildWorkspaceGenerationKey(VOLUME_ID, SANDBOX_ID, 'tenant/local-first')

    await expect(store.compareAndSetLatest(workspaceKey, '0', '2')).resolves.toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.every(([command]) => command.input.Body === undefined)).toBe(true)
  })

  it('rejects keys outside the configured prefix', async () => {
    const store = new S3GenerationObjectStore({ send: vi.fn() } as any, 'test-bucket', 'tenant/local-first')
    await expect(store.getLatest(buildWorkspaceGenerationKey(VOLUME_ID, SANDBOX_ID, 'other')))
      .rejects.toThrow('generation_prefix_mismatch')
  })
})
