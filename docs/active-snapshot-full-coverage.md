# Active snapshot full coverage (Issue #19)

## Scope and configuration

Implementation branch: `masiqi/fix-19-active-snapshot-full-coverage`.
Base: `093f390adffce4ba97503bac0e25fb669c20355a` (PR #18 head).

Set the following **on every Daytona API replica**, then restart the API in an
approved release window:

```dotenv
SNAPSHOT_FULL_COVERAGE=true
```

The default is `false` for backward compatibility. With `true`, active published
snapshots converge to every eligible Runner, and both the ratio scale-down cron
and its per-snapshot entry point are disabled. With `false`, shared regions retain
the original `ceil(runners / 3)` target and `ceil(target * 1.15)` removal threshold;
organization regions still propagate to all eligible Runners. Do not mix settings
across API instances: a legacy instance can still schedule removals.

This is **not permanent retention**. Existing idle deactivation (organization
timeout, default 14 days, excluding general snapshots), inactive cleanup, explicit
deletion and missing-Runner cleanup remain enabled. A ref still used by an active
alias must not be removed by inactive, explicit-delete or old BuildInfo cleanup.
Idle deactivation also checks for a remaining active alias after updates, including
when an alias update fails.

## Reconciliation contract

- Existing active-snapshot pagination runs every five seconds (150 snapshots per
  page). New/recovered eligible Runners and missing replica records are discovered
  on subsequent passes; convergence is not an immediate startup event.
- Eligibility preserves authorized shared/owning-organization regions, READY node
  state, schedulability, Runner class mapping and GPU count/type constraints.
  Draining Runners are excluded. No scheduling or migration policy changes.
- Each pass dispatches at most ten Runner pulls per snapshot. Missing candidates
  are shuffled so deferred/error candidates do not permanently block others.
- An owned Redis lock per `(runnerId, ref)` serializes alias reconciliation. State
  is re-read under the lock; ERROR retries use a conditional state update and a
  one-minute cooldown. A retry starts a new attempt window. All paths release only
  their own lock. Existing job uniqueness remains the final v2 queue deduplicator.
- READY, PULLING, BUILDING and REMOVING entries are not overwritten by propagation.
  REMOVING entries finish the existing remove flow before a later pass repulls.
  No arbitrary job cancellation and no synthetic READY writes are introduced.
- Real pulls use the current Runner adapter and PULL_SNAPSHOT payload. Readiness
  still comes from Runner job completion or the existing snapshot-info polling.
  Non-registry (Windows) refs keep their existing transport/class behavior.

## Release boundary and source provenance

Only the **Daytona API image** needs rebuilding/replacement. Source changes are
API control-plane/config/tests plus this document. There are no schema migrations,
new HTTP endpoints, SDK changes, Runner binary/protobuf changes or Proxy changes.

Evidence in this baseline:

- `apps/api/src/sandbox/runner-adapter/runnerAdapter.v2.ts`: `pullSnapshot` and
  `removeSnapshot` already enqueue PULL_SNAPSHOT / REMOVE_SNAPSHOT through
  `JobService.createJob`. No payload extension is needed.
- `apps/api/src/sandbox/services/job.service.ts`: incomplete jobs are constrained
  by resource type/ref/Runner; existing conflicts and completion handling apply.
- `apps/api/src/sandbox/services/job-state-handler.service.ts`: existing pull
  completion/failure updates replica state; remove completion deletes the record.
- `apps/api/Dockerfile`: the image builds the API bundle and embeds the dashboard
  and migration sources. Rebuild that image from the reviewed source; this does
  not require deploying a standalone dashboard, Proxy or Runner image.
- `apps/api/project.json`: the Nx `docker` target depends on a Runner build target.
  That build dependency is not a requirement to publish/deploy a new Runner.
  An API-only image build can use the existing Dockerfile directly.
- `.github/workflows/pr_docker_build.yaml` is upstream-repository gated and only
  builds; `.github/workflows/release.yaml` publishes many components, not an
  API-only rollout. Do not trigger the broad release workflow for this change.

Before any later release, record the exact reviewed **new full commit SHA** that
contains this patch and the immutable resulting API `image@sha256:...` digest.
Neither the PR #18 baseline SHA nor any old fixed workflow `ref` contains this
feature. Action version SHAs pin CI actions, not application source. Verify the
actual checkout SHA, build context and image provenance/labels against the new
commit; do not substitute a mutable branch/tag or assume a successful CI run on
another ref validates these changes. The integration branch for this work is
`ruiinsurance/develop`, initialized at the PR #18 head below, not maintenance main.

### Development branch lineage (2026-10-16)

`ruiinsurance/develop` preserves the existing source baseline at
`093f390adffce4ba97503bac0e25fb669c20355a`. Issue #19 is proposed separately
from `masiqi/fix-19-active-snapshot-full-coverage` into this integration branch.
Creating the branch preserves existing code; it is not approval, merger or
production acceptance of the still-open PRs #16 and #18.

Verified ancestry, oldest to newest:

- `6c9c26b57`: existing COS/local-first product lineage.
- `a8e04256a` (PR #16, 2026-08-22): local-only sandbox storage, stable UUIDs,
  authoritative Runner ownership, fail-closed legacy COS handling and SDK updates.
- `db11e9a9d` (2026-08-24): same-owner local sandbox rebuild.
- `d6d45de28` through `40d00e679` (2026-09-04/05): exact local workspace
  recovery, container build checksums, transient mount/inspect retries and
  container-root-scoped mount identity checks.
- `618c9c84b`, `a8db4f76c`, `093f390ad` (PR #18, 2026-09-12): recreate only
  missing compute over retained local storage, accept named retained volumes and
  recover after failed start. Existing API tests cover these recovery paths.

The existing remote `develop` is left unchanged at `04cc017e45a1b2e9ef65933dd226944101dbe57d`.
It diverges from this baseline (162 commits on the baseline side, six on its own
side, including sandbox-class/linked-sandbox/Android work). It is not a safe
drop-in base and is not overwritten. Remote `main` at `ec4c21b2d` also diverges;
its three baseline-missing commits are a Go checksum sync, maintenance notice
and license-link update. Neither branch is silently merged into this patch.

PR #16 currently targets `feat/cos-single-bucket-volumes`; PR #18 targets
`masiqi/feat-594-local-sandbox-same-owner-rebuild`. Their changes are already
ancestors of the integration baseline, despite their open GitHub status. Do not
blindly retarget or cherry-pick them into this descendant branch: that would not
represent a fresh integration of their features. Decide their review/disposition
separately, retaining links and original commits. Both reported no GitHub status
checks at inspection time; historical PR verification is not new runtime proof.

Recommended future policy: issue-scoped branches and reviewed PRs into
`ruiinsurance/develop`; release candidates built from an exact approved commit
with recorded API/Runner/Proxy digests. A maintained branch alone is not a
deployment trigger. Default-branch settings, protections and release automation
are deliberately unchanged here. API-only release scope applies to Issue #19's
delta, not to deploying PR #16/#18 for the first time onto an older installation.

### Existing Suna delivery workflow audit

Read-only inspection on 2026-10-16 of `ruiinsurance/suna-enterprise`, default
branch `prod`, commit `e44062b9715e0f66012b91b5ba1e8ce93841963c`, workflow
`.github/workflows/m4-daytona-product-release.yml` (blob
`37d3bd27983874676485723ce305283cde6dd3b8`) found:

- General delivery still pins `DAYTONA_DELIVERY_COMMIT` to
  `cf912acd870d34f395413b074d186df5a65e1ef4` and `DAYTONA_SOURCE_COMMIT` to
  `94c2d7c362ada11e04cfd7cebc9e42fb92b53e1a`. These are not this implementation's
  source. The general `run` path must not be mistaken for a build of this patch.
- The separate `workspace-lifecycle` mode checks out `daytona_lifecycle_ref`.
  Its default is `masiqi/feat-594-local-sandbox-same-owner-rebuild`, and its default
  version is `v0.190.0-workspace-lifecycle-633-r3`. A later build needs an explicit
  reviewed new full commit SHA and a new immutable candidate version, not defaults.
- That mode currently builds **and pushes both** API and Runner, plus a
  computer-use build artifact; it records resolved checkout SHA and registry
  RepoDigests in `daytona-workspace-lifecycle-images.tsv` and its checksum.
  This is a tooling boundary, not evidence that this feature requires a new Runner.
  Do not dispatch it unchanged for an API-only publication. A later separately
  approved API-only build must retain its checkout/mirror/digest evidence discipline
  while selecting only `apps/api/Dockerfile`, without publishing/replacing Runner
  or Proxy. Record the API's registry RepoDigest, not a local Docker image ID.

No Suna source or workflow was modified or triggered during this work. These
observations are pinned to the inspected workflow revision and must be rechecked
before a future release.

## Later approved rollout (not executed here)

1. Preserve the current API digest, environment values and deployment manifests.
   Verify the new source includes the baseline's recovery/local-storage features;
   the adapter fingerprint alone does not prove the full production image source.
2. In isolation, build the API image from the reviewed new SHA, record its digest
   and validate the flag enabled/disabled. Keep Proxy and Runner digests unchanged.
3. Budget disk/registry/network capacity for one replica on every eligible Runner.
   Existing queue throughput still bounds physical pulls, beyond API dispatch caps.
4. In a later maintenance window, deploy only the pinned API image and enable the
   flag consistently across API instances. No migration is introduced by this patch;
   review the baseline's migration lineage separately before any migration command.
5. Existing REMOVING records and queued/in-progress REMOVE_SNAPSHOT jobs may still
   complete. Do not mark them READY, delete queue rows or cancel arbitrary jobs.
   Allow completion and subsequent real repulls; avoid declaring coverage complete
   while removals/pulls/errors are outstanding. Investigate genuinely stuck jobs
   separately using the established operational procedure.
6. Only after approval, observe active refs reaching READY on all eligible nodes,
   exclusion of unauthorized/incompatible/draining nodes, and absence of new
   ratio-driven removals. Idle deactivation and inactive removal remain expected.

## Rollback

For a policy-only rollback, set `SNAPSHOT_FULL_COVERAGE=false` consistently on all
API instances and restart them. **This intentionally re-enables ratio removal**,
including replicas older than one hour. It is not a freeze or permanent retention
mode. Already queued pull/remove jobs may finish after the toggle.

For a code rollback, restore the previously recorded API image digest and its
environment/manifest. No schema downgrade is required by this patch. Leave Proxy
and Runner images unchanged. Never point rollback at a guessed tag or PR baseline
without confirming that it matches the previously deployed image's full lineage.

## Verification record

Validation runs only in an isolated directory on `10.1.0.242`, not production or
the developer's macOS machine. Directory:
`/home/siqi/work/daytona-issue19-20261016`. The tracked baseline was streamed with
`git archive`, then only changed source/tests were copied in. The archive includes
the baseline's committed default `.env`, not the developer's working-copy
overrides. No production environment export, working-copy secret file or service
data was copied.

On 2026-10-16, Linux x86_64, Node **24.21.0**, Yarn **4.13.0**:

```sh
export CI=true NX_DAEMON=false
corepack yarn install --immutable
corepack yarn jest --config apps/api/jest.config.ts --runInBand \
  --runTestsByPath apps/api/src/sandbox/managers/snapshot.manager.spec.ts
corepack yarn jest --config apps/api/jest.config.ts --runInBand
corepack yarn tsc -p apps/api/tsconfig.app.json --noEmit
corepack yarn tsc -p apps/api/tsconfig.spec.json --noEmit
corepack yarn eslint apps/api/src/sandbox/managers/snapshot.manager.ts \
  apps/api/src/sandbox/managers/snapshot.manager.spec.ts apps/api/src/config/configuration.ts
corepack yarn prettier --check apps/api/src/sandbox/managers/snapshot.manager.ts \
  apps/api/src/sandbox/managers/snapshot.manager.spec.ts apps/api/src/config/configuration.ts
corepack yarn nx build api --configuration=production --skip-nx-cache --nxBail
corepack yarn markdownlint-cli2 docs/active-snapshot-full-coverage.md
```

- Red: the initial 24 behavior tests against unchanged baseline source produced
  **12 expected failures / 12 passes** (after correcting the test GPU enum).
- Green: **79 suites / 717 tests passed**, including **27** snapshot coverage tests.
  This includes additional concurrent completion, partial idle-deactivation failure
  and old ERROR retry-window regression cases.
- API application and test TypeScript checks, changed-file ESLint/Prettier checks
  and uncached API production Webpack build all passed. Document Markdown lint
  also passed with zero errors.
- Nix is unavailable on the remote host, so the prescribed Nix shell could not be
  used; the existing remote Node 24 toolchain matches the API Dockerfile's major
  version. No local validation was run. An earlier macOS dependency install was
  stopped/cleaned up after the user's instruction; no local tests/builds were run.
- Yarn reported existing peer-dependency warnings and an optional ssh2 native
  crypto binding fallback; install completed successfully without lockfile changes.
- Logs remain on the remote host at `/tmp/daytona-issue19-red.log`,
  `/tmp/daytona-issue19-api-tests-final.log`, `/tmp/daytona-issue19-build-final.log`
  and `/tmp/daytona-issue19-lint.log`.

These are repository/adapter-mocked unit and regression tests, not a live four-node
image-pull acceptance test. No services were started for verification, no container
image was built/published, and no production test, mutation, deployment or merge
was performed. Production coverage and complete deployed-image provenance remain
later operational acceptance work; this document does not claim they are resolved.
