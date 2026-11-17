# Durable local workspace recovery metadata

Tracking: Daytona #24 / suna-enterprise #784.

Production source deletes DESTROYED sandbox rows after 24 hours while the
dedicated workspace recovery endpoint requires the same row. Backup-backed
logical identities can outlive that retention boundary by days or months.

This slice adds a private `sandbox_workspace_recovery_metadata` table. Cleanup
captures the complete PostgreSQL row for canonical local workspaces before
deleting the live row, in the same transaction and under the same per-sandbox
Redis lock used by recovery. Both leases are re-proved before deletion. Ordinary
ephemeral/remote rows retain their cleanup behavior. Invalid canonical local
metadata stops cleanup rather than silently losing the recovery descriptor.

Only the dedicated, organization-authenticated recovery endpoint reads this
table. Its first lookup is read-only; row reconstruction occurs under its state
change lock and a per-ID PostgreSQL advisory lock. The descriptor is server
owned, version checked and validated against the exact organization, owner when
recorded, and canonical workspace. Ordinary create cannot reuse a retained ID.
Resources, snapshot/build FK, network policy, environment and daemon token are
restored from PostgreSQL's row type, not guessed from an external UUID. Missing
FKs or schema incompatibility fail closed. Reconstruction invalidates negative
lookup cache and restores activity bookkeeping.

The migration seeds still-existing destroyed rows. It cannot recreate metadata
that was deleted before the migration: retained job evidence for those cases
requires a separately reviewed drift-aware reconciliation path. Do not claim
that this slice alone heals all historical failures.

## Security and retention

The private recipe includes environment/auth material already present in the
source sandbox table. Do not expose it through DTOs, public APIs, logging,
metrics labels or operator reports. Scope access to the existing API database
principal. There is deliberately no cascading sandbox FK or automatic 24-hour
TTL: deleting the live row must not delete its recovery recipe. Permanent
retirement requires an explicit workspace/backup lineage purge contract.

Migration rollback keeps the table and its data. Reapplying is idempotent. An
old API ignores it; reverting API code restores the old recovery limitation, so
rollout/rollback must preserve backups and stop relying on delayed recovery
until the fixed API is active again.

## Acceptance

Use GitHub's isolated `daytona_recovery_test` database for archive/delete atomicity,
full descriptor restoration including microsecond timestamps, actor/owner
isolation, reserved IDs and lease loss. Run recovery/destruction service tests
and API typecheck/build there. No local tests/builds were executed.

Then use a disposable enterprise test sandbox: encrypted conversation -> backup
-> workspace destruction -> simulate the 24-hour metadata cleanup -> access
with the original logical ID -> verified restore and compute -> history display
and new message. Verify no duplicate Volume/job or alternate owner. Suna's
activation-resume change is the paired dependency. Production rollout is user
driven; no issue closes before environment evidence.

Implementation baseline: 98329e1634bbd76b34c65bd2f316e70d43b97d39,
the existing Issue 732 cursor precision branch. This is an inspected source
baseline, not a new attestation of the deployed image digest. Review the full
release diff before producing a production image.
