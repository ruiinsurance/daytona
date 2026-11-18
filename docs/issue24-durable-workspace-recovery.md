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

The migration seeds still-existing destroyed rows. For already-cleaned cases,
the dedicated endpoint accepts an optional caller-persisted current snapshot
name. A compatibility path requires a single completed CREATE, a latest exact
completed local-workspace destruction, no incomplete jobs, matching organization,
owner, canonical mount pair, resources, network policy and catalog image ref.
Any subsequent rebuild/resize/network/owner drift or unsupported history is
rejected. It never chooses a default image or another owner. The row is created
only under the same state-change/advisory locks, then a complete durable recipe
is retained. Retained recipes take precedence over historical inference.

Historical synthesis generates a fresh daemon token instead of reviving the
original CREATE token, which may have been rotated. A retained complete recipe
preserves its last pinned credential for idempotent recovery-job replay. These
daemon tokens are separate from the encrypted conversation key inside the
workspace. Secrets remain server-side when retaining/restoring descriptors so
SQL error parameters do not contain an entire environment/credential recipe.

This path deliberately does not claim all historical failures are repairable:
the read-only production cohort must establish coverage, and ambiguous cases
remain protected for review. No batch mutation is enabled by these changes.

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
