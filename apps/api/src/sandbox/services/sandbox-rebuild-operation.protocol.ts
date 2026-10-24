/* Copyright 2025 Daytona Platforms Inc. SPDX-License-Identifier: AGPL-3.0 */

// Mutation admission and expired-preflight cancellation are serialized in Redis.
// Once mutation is admitted, absence/expiry of the lock is never failure proof.
export const ADMIT_REBUILD_MUTATION = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local raw = redis.call('GET', KEYS[2])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.status ~= 'running' or record.stage ~= 'preflight'
  or record.sandboxId ~= ARGV[2] or record.operationId ~= ARGV[3]
  or record.targetSnapshot ~= ARGV[4] then return 0 end
record.stage = 'mutating'
redis.call('SET', KEYS[2], cjson.encode(record), 'EX', ARGV[5])
return 1
`

export const RECONCILE_EXPIRED_REBUILD_PREFLIGHT = `
local raw = redis.call('GET', KEYS[3])
if not raw then return nil end
local record = cjson.decode(raw)
if record.sandboxId ~= ARGV[1] or record.operationId ~= ARGV[2]
  or record.targetSnapshot ~= ARGV[3] then return nil end
if record.status ~= 'running' or record.stage ~= 'preflight'
  or redis.call('EXISTS', KEYS[1]) == 1 then return raw end
if not record.previousSnapshot or not record.ownerRunnerId then return raw end
record.status = 'complete'
record.result = { outcome = 'rebuild_preflight_failed', sandboxId = record.sandboxId,
  operationId = record.operationId, targetSnapshot = record.targetSnapshot,
  previousSnapshot = record.previousSnapshot, ownerRunnerId = record.ownerRunnerId }
redis.call('SET', KEYS[3], cjson.encode(record), 'EX', ARGV[4])
if redis.call('GET', KEYS[2]) == record.operationId then redis.call('DEL', KEYS[2]) end
return cjson.encode(record)
`

export const REBUILD_PREFLIGHT_TIMEOUT_MS = 15 * 60_000

export async function withRebuildPreflightDeadline<T>(
  action: () => Promise<T>,
  timeoutMs = REBUILD_PREFLIGHT_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      action(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Rebuild preflight timed out before compute mutation')), timeoutMs)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
