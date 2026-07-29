/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

const CANONICAL_LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function hasUnsafeSegments(path: string): boolean {
  return path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

export function assertSafeFixedBucket(bucket: string): void {
  if (!bucket || bucket !== bucket.trim() || bucket.includes('/') || bucket.includes('\\')) {
    throw new Error(`Invalid fixed S3 bucket ${JSON.stringify(bucket)}: expected a non-empty bucket name`)
  }
}

export function assertSafeS3Prefix(prefix: string): void {
  const path = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix
  if (
    !prefix ||
    !prefix.endsWith('/') ||
    prefix !== prefix.trim() ||
    prefix.startsWith('/') ||
    prefix.includes('\\') ||
    hasUnsafeSegments(path)
  ) {
    throw new Error(`Invalid volume prefix ${JSON.stringify(prefix)}: expected a non-empty canonical relative path`)
  }
}

export function buildCanonicalVolumePrefix(rootPrefix: string, volumeId: string): string {
  if (!CANONICAL_LOWERCASE_UUID.test(volumeId)) {
    throw new Error(`Invalid volume ID ${volumeId}: expected a canonical lowercase UUID`)
  }
  if (!rootPrefix || rootPrefix !== rootPrefix.trim() || rootPrefix.endsWith('/')) {
    throw new Error(
      `Invalid volume prefix ${JSON.stringify(rootPrefix)}: expected a non-empty canonical relative path without a trailing slash`,
    )
  }

  const prefix = `${rootPrefix}/${volumeId}/`
  assertSafeS3Prefix(prefix)
  return prefix
}
