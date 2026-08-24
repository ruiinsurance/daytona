/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { InjectRedis } from '@nestjs-modules/ioredis'
import { Injectable } from '@nestjs/common'
import { Redis } from 'ioredis'

type Acquired = boolean

export class LockCode {
  constructor(private readonly code: string) {}

  public getCode(): string {
    return this.code
  }
}

@Injectable()
export class RedisLockProvider {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async lock(key: string, ttl: number, code?: LockCode | null): Promise<Acquired> {
    const keyValue = code ? code.getCode() : '1'
    const acquired = await this.redis.set(key, keyValue, 'EX', ttl, 'NX')
    return !!acquired
  }

  async getCode(key: string): Promise<LockCode | null> {
    const keyValue = await this.redis.get(key)
    return keyValue ? new LockCode(keyValue) : null
  }

  async unlock(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async unlockOwned(key: string, code: LockCode): Promise<boolean> {
    const removed = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('DEL', KEYS[1])
       end
       return 0`,
      1,
      key,
      code.getCode(),
    )
    return Number(removed) === 1
  }

  async refreshOwned(key: string, ttl: number, code: LockCode): Promise<boolean> {
    const refreshed = await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then
         return redis.call('EXPIRE', KEYS[1], ARGV[2])
       end
       return 0`,
      1,
      key,
      code.getCode(),
      ttl,
    )
    return Number(refreshed) === 1
  }

  async isLocked(key: string): Promise<boolean> {
    const exists = await this.redis.exists(key)
    return exists === 1
  }

  async waitForLock(key: string, ttl: number, timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs !== undefined ? Date.now() + timeoutMs : null
    while (true) {
      if (deadline !== null && Date.now() >= deadline) {
        throw new Error(`Timed out after ${timeoutMs}ms waiting for lock '${key}'`)
      }
      const acquired = await this.lock(key, ttl)
      if (acquired) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
}
