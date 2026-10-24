import { randomUUID } from 'node:crypto'
import Redis from 'ioredis'
import {
  ADMIT_REBUILD_MUTATION,
  RECONCILE_EXPIRED_REBUILD_PREFLIGHT,
  withRebuildPreflightDeadline,
} from './sandbox-rebuild-operation.protocol'
const integration = process.env.REBUILD_PROTOCOL_REDIS_TEST === '1' ? test : test.skip
const identity = {
  sandboxId: 'sandbox',
  operationId: 'operation',
  targetSnapshot: 'target',
  previousSnapshot: 'previous',
  ownerRunnerId: 'owner',
}
async function fixture() {
  const url = process.env.REBUILD_PROTOCOL_REDIS_URL
  if (!url) throw new Error('Configure the designated CI/test Redis URL explicitly')
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 5_000,
    retryStrategy: () => null,
  })
  await redis.connect()
  const prefix = `issue732:${randomUUID()}`
  const keys = [`${prefix}:lock`, `${prefix}:active`, `${prefix}:operation`]
  try {
    await redis.set(keys[1], identity.operationId, 'EX', 600)
    await redis.set(keys[2], JSON.stringify({ ...identity, status: 'running', stage: 'preflight' }), 'EX', 600)
  } catch (error) {
    redis.disconnect()
    throw error
  }
  const cancel = async () =>
    JSON.parse(String(
      await redis.eval(
        RECONCILE_EXPIRED_REBUILD_PREFLIGHT,
        3,
        ...keys,
        identity.sandboxId,
        identity.operationId,
        identity.targetSnapshot,
        '600',
      ),
    ))
  const mutate = async () =>
    Number(await redis.eval(
      ADMIT_REBUILD_MUTATION,
      2,
      keys[0],
      keys[2],
      'owner-token',
      identity.sandboxId,
      identity.operationId,
      identity.targetSnapshot,
      '600',
    ))
  const cleanup = async () => {
    try { await redis.del(...keys) }
    finally { redis.disconnect() }
  }
  return { redis, keys, cancel, mutate, cleanup }
}
integration('expired preflight cancellation fences a late old worker before destruction', async () => {
  const { redis, keys, cancel, mutate, cleanup } = await fixture()
  try {
    expect((await cancel()).result.outcome).toBe('rebuild_preflight_failed')
    await redis.set(keys[0], 'owner-token', 'EX', 600)
    expect(await mutate()).toBe(0)
  } finally { await cleanup() }
})
integration('an active owner cannot be cancelled, and admitted mutation is never terminalized from expiry', async () => {
  const { redis, keys, cancel, mutate, cleanup } = await fixture()
  try {
    await redis.set(keys[0], 'owner-token', 'EX', 600)
    expect((await cancel()).status).toBe('running')
    expect(await mutate()).toBe(1)
    await redis.del(keys[0])
    const result = await cancel()
    expect(result.status).toBe('running')
    expect(result.stage).toBe('mutating')
  } finally { await cleanup() }
})
integration('foreign ownership cannot admit mutation and foreign active evidence survives old reconciliation', async () => {
  const { redis, keys, cancel, mutate, cleanup } = await fixture()
  try {
    await redis.set(keys[0], 'foreign-token', 'EX', 600)
    expect(await mutate()).toBe(0)
    await redis.del(keys[0])
    await redis.set(keys[1], 'new-operation', 'EX', 600)
    await cancel()
    expect(await redis.get(keys[1])).toBe('new-operation')
  } finally { await cleanup() }
})
test('bounded preflight returns failure even when snapshot preparation never resolves', async () => {
  await expect(withRebuildPreflightDeadline(() => new Promise(() => {}), 5)).rejects.toThrow('before compute mutation')
})
