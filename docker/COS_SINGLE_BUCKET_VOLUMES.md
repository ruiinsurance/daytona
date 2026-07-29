# Tencent COS Single-Bucket Volumes

This opt-in layout stores multiple Daytona Volumes in one existing private Tencent COS bucket. The default remains one S3 bucket per Volume.

## Object Layout

```text
s3://<bucket-name-appid>/<volume-root>/<volume-uuid>/sandboxes/<sandbox-id>/workspace/...
```

For the R3 production contract, `<volume-root>` is `r3-prod/daytona/volumes`. Daytona keeps the logical Volume name and UUID in its database. The Runner host mount remains `/mnt/daytona-volume-<volume-uuid>`.

The API creates a `.daytona-volume` marker inside each Volume prefix. Deleting a Volume deletes only the exact canonical `<volume-root>/<volume-uuid>/` prefix, including paginated versions and delete markers. It never deletes or tags the shared bucket.

## API Configuration

```dotenv
S3_ENDPOINT=https://cos.<region>.myqcloud.com
S3_REGION=<region>
S3_ACCESS_KEY=<server-side-secret-id>
S3_SECRET_KEY=<server-side-secret-key>
S3_VOLUME_LAYOUT=single-bucket-prefix
S3_DEFAULT_BUCKET=<bucket-name-appid>
S3_VOLUME_PREFIX=r3-prod/daytona/volumes
S3_FORCE_PATH_STYLE=false
S3_STS_PROVIDER=disabled
```

`S3_VOLUME_PREFIX` must be a non-empty relative path without a leading or trailing slash, backslashes, empty segments, `.`, or `..`. Volume IDs must be canonical lowercase UUIDs.

In this MVP, `GET /object-storage/push-access` returns HTTP 503. Long-lived COS credentials remain server-side and are never returned as temporary client credentials. Tencent STS/CAM support is outside this contract.

## Runner Configuration

```dotenv
AWS_ENDPOINT_URL=https://cos.<region>.myqcloud.com
AWS_REGION=<region>
AWS_ACCESS_KEY_ID=<server-side-secret-id>
AWS_SECRET_ACCESS_KEY=<server-side-secret-key>
AWS_VOLUME_LAYOUT=single-bucket-prefix
AWS_DEFAULT_BUCKET=<bucket-name-appid>
AWS_VOLUME_PREFIX=r3-prod/daytona/volumes
```

The Runner invokes the mount helper with this stable argument shape:

```text
mount-s3 <existing-options> --prefix r3-prod/daytona/volumes/<volume-uuid>/ <bucket-name-appid> /mnt/daytona-volume-<volume-uuid>
```

The helper must interpret `--prefix` as an object-key prefix. An s3fs wrapper should map it to the s3fs prefix option and use COS virtual-hosted requests; it must not force path-style requests.

## Snapshot Boundary

Use an existing SWR prebuilt image reference for `DEFAULT_SNAPSHOT` and sandbox creation. Do not use an SDK snapshot build context in this mode because obtaining push credentials is intentionally disabled. This adaptation does not build or publish Daytona, Runner, sandbox, or Suna images.

## Non-Production Probe Plan

Run this plan only against an explicitly approved non-production COS bucket and temporary probe prefix:

1. Verify `HeadBucket` with the API and Runner server identities.
2. Put, get, list, and delete a probe object under one isolated canonical Volume UUID prefix.
3. Mount the prefix with the Runner helper, write `sandboxes/<sandbox-id>/workspace/probe.txt`, and read it back.
4. Restart or replace the Runner and verify the same workspace file through the same Volume UUID.
5. Place a sentinel under a sibling Volume prefix, delete the probe Volume through Daytona, and prove the sentinel remains.
6. Confirm the deleted prefix has no live objects, versions, or delete markers and that the shared bucket still exists.

Never use this probe against production credentials or a production bucket without a separately approved change window.

## Suna Follow-Up

Suna integration is a separate change. It must update the `mount-s3` s3fs wrapper for `--prefix`, remove forced path-style requests, map the API and Runner variables into Secrets and deployment templates, document the existing SWR snapshot reference, and update the storage inventory and Chinese runbook.
