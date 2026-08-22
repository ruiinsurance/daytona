# Local Volume Backend V1

The local volume backend is an opt-in backend for container-class sandboxes whose workspace must remain on one Runner. It reuses the persisted `sandbox.runnerId` as the only owner record and does not add automatic failover, migration, replication, NFS, or COS synchronization.

Both the API and the eligible Runner must enable the backend explicitly:

```dotenv
# API
LOCAL_VOLUME_BACKEND_ENABLED=true

# Runner
LOCAL_VOLUME_BACKEND_ENABLED=true
LOCAL_VOLUME_ROOT=/srv/daytona-local-volumes
```

The default is disabled in both processes. A Runner advertises the capability only after it starts successfully with a valid local root. Initial placement considers only READY, schedulable, non-draining Runners that advertise this capability.

`LOCAL_VOLUME_ROOT` must be an absolute, canonical directory without symbolic-link components. When the Runner itself is containerized, bind the host directory into the Runner container at the same absolute path. The Docker daemon and Runner must resolve `LOCAL_VOLUME_ROOT` to the same host directory.

## Create Contract

A local sandbox create request must provide:

- `storageBackend: "local"`;
- a canonical lowercase UUIDv4 `id` supplied by the trusted control plane;
- a resolved Daytona Volume mounted at `/workspace` with subpath `sandboxes/<sandbox-id>/workspace`;
- a container-class snapshot or declarative container build.

The API expands the workspace into two explicit Runner mounts. Both use the same Volume ID and source subpath:

```text
/srv/daytona-local-volumes/
  daytona-volume-<canonical-volume-uuid>/
    sandboxes/<canonical-sandbox-uuid>/workspace
```

The directory is bound to both `/workspace` and `/config`. Other sandbox classes and non-canonical workspace identities are rejected.
V1 does not support mixing local and COS mounts in one sandbox; any additional volume target is rejected.

Daytona creates parent directories with owner-only traversal and makes the UUID-scoped workspace leaf writable by the sandbox user. The Runner cannot resolve an image-local user to a host UID before container creation, so the workspace leaf uses mode `0777`; only that leaf is mounted into its owner sandbox.

## Owner Semantics

The first successful sandbox insert persists exactly one `runnerId`. Start, recovery, and archived-container replacement continue to use that owner. Local sandboxes are excluded from automatic cross-Runner migration and from the COS recovery branches that clear or rewrite `runnerId`.

Archiving a local sandbox removes its container but keeps `runnerId` and the canonical Runner-local directory. A later start recreates the container only on that owner. Local sandboxes do not enter the COS backup lifecycle: manual backup requests fail, automatic and draining-runner backup queries exclude them, and stale backup state is cleared when a local archive completes. Draining workflows do not force-stop, archive, migrate, recover, or retry backups for local sandboxes.

If the owner is missing, not READY, unschedulable, draining, or no longer advertises the local backend, start and recovery fail with HTTP 503:

```json
{
  "statusCode": 503,
  "error": "Service Unavailable",
  "message": "The local volume owner Runner is unavailable",
  "code": "owner_runner_unavailable",
  "ownerRunnerId": "<persisted-runner-id>"
}
```

No other Runner may create the sandbox while the owner is unavailable. When the same Runner becomes available again, Daytona starts or recreates the container there using the same canonical directory.

## Mount Validation

The Runner does not invoke `mount-s3` for local mounts. Before create or start it validates the backend, Volume UUID, sandbox subpath, root, and every path component; symbolic links, traversal, unexpected targets, and mismatched `/workspace` and `/config` sources fail closed.

After the container starts, the Runner verifies through Docker inspect and the container mount namespace that:

- both targets are explicit bind mounts;
- each inspect source exactly matches the canonical local source;
- the host source and container targets use the expected filesystem device;
- `/workspace` and `/config` resolve to the same device and inode.

A failed post-start check stops the container before returning the error.

## Compatibility And Rollback

Existing rows migrate with `storageBackend = "cos"`; existing Runners migrate with local capability disabled. COS sandboxes keep the current `mount-s3` contract and existing scheduling and recovery behavior.

To stop admitting new local sandboxes, disable `LOCAL_VOLUME_BACKEND_ENABLED` on the API. Keep it enabled on owner Runners while existing local sandboxes still need to start. Disabling it on an owner makes those sandboxes fail closed; it never converts them to COS and never moves them. Removing local data or changing ownership requires a separately reviewed manual migration outside this V1.
