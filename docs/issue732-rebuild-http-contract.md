# Rebuild failure HTTP contract (Suna issue #732)

## Defect and scope

The rebuild controller already returned typed failures as `HttpException` bodies,
but `AllExceptionsFilter` serialized only the legacy error envelope. Thus a direct
controller unit test could pass while a real HTTP client lost the operation ID,
outcome, retryability, owner and snapshot identity. Eligibility conflict codes
were lost at the same boundary. A known provider result became ambiguous to Suna;
the retained operation GET remained available for safe reconciliation.

The UAT failed-preflight attempt established retained terminal provider evidence
and automatic restoration of the old runtime. Its original POST status/body was
not captured. The HTTP regression proves the serialization defect independently;
it does not reconstruct that missing historical response.

## Public response

The existing HTTP status mapping and legacy `path`, `timestamp`, `statusCode`,
`error`, `message` fields remain. Only `SandboxRebuildHttpException` opts into the
following additional, explicitly projected fields:

- `success: false`, `code`, `outcome`, `retryable`;
- `sandboxId`, `operationId`, `targetSnapshot`;
- `ownerRunnerId`, `previousSnapshot` for terminal failure results that carry them.

Eligibility refusals expose only their fixed `code`: `control_plane_inconsistent`,
`remote_operation_unresolved`, or `historical_identity_requires_review`.
`LocalSandboxStorageIdentityError` retains its existing class/message and exposes
only the fixed `storage_identity_invalid` code. Other exception bodies do not gain
arbitrary property passthrough, including when thrown from a rebuild route.

The exception's service-result import is type-only. No runtime service dependency
is added to the global filter. Raw diagnostics, Axios configuration, credentials
and remote bodies must never be added to the public projection.

## Recovery and release boundaries

This patch changes Daytona API serialization only. It does not change Redis
records, SQL schema, lease durations, job admission, callback fencing, Runner,
Proxy or the state tool. A retryable field is not permission to bypass an active
operation: Suna must still use its existing owned recovery and exact evidence.

Merge the provider PR, then build the fork's API image from that exact merged
revision using the existing release workflow. Pin the resulting API digest in the
test environment and verify the failed-preflight HTTP response plus old-runtime
availability before a production release. This patch requires no new migration or
Runner/Proxy/state-tool update. Keep the previously required companion releases;
do not replace them with upstream stock images.

Rollback consists of restoring the prior API digest under the existing controlled
release procedure. No database restore or operation/protocol rewrite is needed.
The prior API can again lose typed failure fields, so unknown outcomes must retain
the existing safe reconciliation fence.

The extra recovery-lease publication delay remains under investigation. Passing
these tests does not qualify legacy/manual-fenced production sandboxes for updates
or establish historical 45f43 recovery acceptance.

## Validation

Execute only in GitHub or the agreed enterprise test environment. The user's local
execution boundary prohibits tests, builds, dependency installation and containers.

`sandbox-rebuild.http.spec.ts` starts an actual Nest HTTP application with the real
controller and production global exception filter. It uses fixed test auth and
mocked POST service results; eligibility refusals execute the actual service and
assert zero Runner lookup/inspection, snapshot resolution or adapter creation.
It covers all five failure/pending results, unchanged success, public field
projection, generic exception redaction, storage rejection and auth tracking.
This is HTTP serialization acceptance, not live provider/Runner or production auth
acceptance. Existing Redis/lifecycle suites and API typecheck/build remain CI gates.
