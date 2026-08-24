/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { LockCode, RedisLockProvider } from './redis-lock.provider'

describe('RedisLockProvider ownership operations', () => {
  it('refreshes only the lock owned by the supplied token with the requested TTL', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) }
    const provider = new RedisLockProvider(redis as never)
    const code = new LockCode('operation-token')

    await expect(provider.refreshOwned('sandbox:test:state-change', 300, code)).resolves.toBe(true)

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('EXPIRE', KEYS[1], ARGV[2])"),
      1,
      'sandbox:test:state-change',
      'operation-token',
      300,
    )
  })

  it('unlocks only when the stored lock is owned by the supplied token', async () => {
    const redis = { eval: jest.fn().mockResolvedValue(1) }
    const provider = new RedisLockProvider(redis as never)
    const code = new LockCode('operation-token')

    await expect(provider.unlockOwned('sandbox:test:state-change', code)).resolves.toBe(true)

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("return redis.call('DEL', KEYS[1])"),
      1,
      'sandbox:test:state-change',
      'operation-token',
    )
  })
})
