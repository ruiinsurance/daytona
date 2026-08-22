# Runner-Local Sandbox Storage V1

Runner-local disk is the only supported sandbox volume backend. Daytona reuses the persisted `sandbox.runnerId` as the only owner record and does not add automatic failover, migration, replication, NFS, backup, or COS synchronization.

The Runner requires one path setting:

```dotenv
LOCAL_VOLUME_ROOT=/srv/daytona-local-volumes
```

This is a mount location, not a feature switch. There is no API or Runner enable flag and no caller-selectable storage backend. A Runner advertises local-volume capability after it starts successfully with a valid local root. Initial placement considers only READY, schedulable, non-draining Runners that advertise this capability.

`LOCAL_VOLUME_ROOT` must already exist as an absolute, canonical directory without symbolic-link components. The Runner fails startup rather than creating a missing directory, because an auto-created container directory could hide a missing host mount. When the Runner itself is containerized, bind the host directory into the Runner container at the same absolute path. The Docker daemon and Runner must resolve `LOCAL_VOLUME_ROOT` to the same host directory.

## Create Contract

A sandbox create request must provide:

- a canonical lowercase UUIDv4 `id` supplied by the trusted control plane;
- a resolved Daytona Volume mounted at `/workspace` with subpath `sandboxes/<sandbox-id>/workspace`;
- a container-class snapshot or declarative container build.

The external create DTO does not accept `storageBackend`. The API assigns `local` internally and rejects attempts to send a backend choice.

The API expands the workspace into two explicit Runner mounts. Both use the same Volume ID and source subpath:

```text
/srv/daytona-local-volumes/
  daytona-volume-<canonical-volume-uuid>/
    sandboxes/<canonical-sandbox-uuid>/workspace
```

The directory is bound to both `/workspace` and `/config`. Other sandbox classes, non-canonical workspace identities, non-local backends, mixed backends, and additional volume targets are rejected before `mount-s3` could run.

Daytona creates UUID-scoped child directories and makes the workspace leaf writable by the sandbox user. The Runner cannot resolve an image-local user to a host UID before container creation, so the workspace leaf uses mode `0777`; only that leaf is mounted into its owner sandbox.

## Owner Semantics

The first successful sandbox insert persists exactly one `runnerId`. Start, recovery, and archived-container replacement continue to use that owner. Sandboxes are excluded from automatic cross-Runner migration and from legacy recovery branches that clear or rewrite `runnerId`.

Archiving a local sandbox removes its container but keeps `runnerId` and the canonical Runner-local directory. A later start recreates the container only on that owner. Local sandboxes do not enter the backup lifecycle: manual backup requests fail, automatic and draining-runner backup queries exclude them, and stale backup state is cleared when a local archive completes. Draining workflows do not force-stop, archive, migrate, recover, or retry backups for local sandboxes.

If the owner is missing, not READY, unschedulable, draining, or no longer advertises local-volume capability, start and recovery fail with HTTP 503:

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

Create and start validate the backend, Volume UUID, sandbox subpath, root, and every path component. Symbolic links, traversal, unexpected targets, and mismatched `/workspace` and `/config` sources fail closed.

After the container starts, the Runner verifies through Docker inspect and the container mount namespace that:

- both targets are explicit bind mounts;
- each inspect source exactly matches the canonical local source;
- the host source and container targets use the expected filesystem device;
- `/workspace` and `/config` resolve to the same device and inode.

A failed post-start check stops the container before returning the error.

## Legacy Rows And Rollback

The migration changes the database default for future inserts to `local` without rewriting existing rows. A legacy row whose persisted backend is not `local` fails start, recover, resize, and background replacement before Runner selection or provider mutation:

```json
{
  "statusCode": 409,
  "error": "Conflict",
  "message": "Only Runner-local sandbox storage is supported",
  "code": "sandbox_storage_backend_unsupported",
  "storageBackend": "cos"
}
```

Legacy rows may be explicitly destroyed and removed. They are not migrated, restored, or reinterpreted as local. Rollback is image-level; there is no runtime switch back to COS.
