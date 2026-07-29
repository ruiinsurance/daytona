/*
 * Copyright 2025 Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  DeleteBucketCommand,
} from '@aws-sdk/client-s3'
import type { ObjectIdentifier } from '@aws-sdk/client-s3'
import { assertSafeFixedBucket, assertSafeS3Prefix } from './s3-volume-prefix'

async function deleteObjectIdentifiers(s3: S3Client, bucket: string, objects: ObjectIdentifier[]): Promise<void> {
  for (let index = 0; index < objects.length; index += 1000) {
    const result = await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: objects.slice(index, index + 1000),
          Quiet: true,
        },
      }),
    )
    if (result.Errors?.length) {
      throw new Error(`failed to delete ${result.Errors.length} object(s) from fixed S3 bucket ${bucket}`)
    }
  }
}

export async function deleteS3Bucket(s3: S3Client, bucket: string): Promise<void> {
  // First delete all object versions & delete markers (if any exist)
  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  do {
    const versions = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    )
    const items = [
      ...(versions.Versions || []).map((v) => ({ Key: v.Key, VersionId: v.VersionId })),
      ...(versions.DeleteMarkers || []).map((d) => ({ Key: d.Key, VersionId: d.VersionId })),
    ]
    if (items.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: items, Quiet: true },
        }),
      )
    }
    keyMarker = versions.NextKeyMarker
    versionIdMarker = versions.NextVersionIdMarker
  } while (keyMarker || versionIdMarker)

  // Then delete any remaining live objects (for unversioned buckets)
  let continuationToken: string | undefined
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        ContinuationToken: continuationToken,
      }),
    )
    if (list.Contents && list.Contents.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: list.Contents.map((o) => ({ Key: o.Key })),
            Quiet: true,
          },
        }),
      )
    }
    continuationToken = list.NextContinuationToken
  } while (continuationToken)

  // Finally delete the (now-empty) bucket
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }))
}

export async function deleteS3Prefix(s3: S3Client, bucket: string, prefix: string): Promise<void> {
  assertSafeFixedBucket(bucket)
  assertSafeS3Prefix(prefix)

  let keyMarker: string | undefined
  let versionIdMarker: string | undefined
  do {
    const versions = await s3.send(
      new ListObjectVersionsCommand({
        Bucket: bucket,
        Prefix: prefix,
        KeyMarker: keyMarker,
        VersionIdMarker: versionIdMarker,
      }),
    )
    const versionedObjects = [...(versions.Versions || []), ...(versions.DeleteMarkers || [])].flatMap((object) =>
      object.Key?.startsWith(prefix) ? [{ Key: object.Key, VersionId: object.VersionId }] : [],
    )
    await deleteObjectIdentifiers(s3, bucket, versionedObjects)

    if (versions.IsTruncated && !versions.NextKeyMarker && !versions.NextVersionIdMarker) {
      throw new Error(`S3 returned a truncated version listing without next markers for prefix ${prefix}`)
    }
    keyMarker = versions.NextKeyMarker
    versionIdMarker = versions.NextVersionIdMarker
  } while (keyMarker || versionIdMarker)

  let continuationToken: string | undefined
  do {
    const list = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    )
    const objects: ObjectIdentifier[] = (list.Contents || [])
      .filter((object) => object.Key?.startsWith(prefix))
      .map((object) => ({ Key: object.Key }))

    await deleteObjectIdentifiers(s3, bucket, objects)

    if (list.IsTruncated && !list.NextContinuationToken) {
      throw new Error(`S3 returned a truncated object listing without a continuation token for prefix ${prefix}`)
    }
    continuationToken = list.NextContinuationToken
  } while (continuationToken)
}
