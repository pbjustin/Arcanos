# Gate R1 PostgreSQL R3B recovery plan

Status: **LOCAL PROCEDURE — NO RAILWAY AUTHORIZATION**

R3A created one empty PostgreSQL identity and stopped. This plan binds that
identity into reviewed tooling and splits the remaining PostgreSQL work into an
offline preparation gate and a later activation gate. It does not authorize a
Railway mutation.

## Fixed identity

- Project: `Arcanos` (`7faf44e5-519c-4e73-8d7a-da9f389e6187`)
- Environment: `phase2e-validation-20260717`
  (`fb99f47d-5ef5-44c1-96c2-acf7b90fab13`)
- Private network: `464f2194-3825-4ac1-a705-192566561675`
- Service: `phase2e-postgres-r3-20260720`
  (`7346b3f6-bf3d-46e1-9d66-79f10847ef89`)
- Service instance: `86dde430-50ac-4d5c-95c3-cb27064eff51`
- Pinned image for the later activation gate:
  `ghcr.io/railwayapp-templates/postgres-ssl:18.4`

No caller may substitute any of these identities.

## Tooling contract

The metadata projector, TCP-proxy projector, secure projector session,
PostgreSQL readiness wrapper, three closed offline-mutation operations, and
PostgreSQL-only configuration wrapper must all fail closed for any other
service or service-instance identity before they read a token, invoke Railway,
generate a credential, or start a child process.

The current PostgreSQL-only configuration wrapper exposes exactly one profile:

- `service-configuration`: set only `restartPolicyType=ON_FAILURE` and
  `restartPolicyMaxRetries=3` for the fixed R3 service.

`postgres-source` is deliberately unavailable in the R3B1 tool. The later
R3B2 source assignment requires a separate reviewed commit, executable, and
authorization.

The offline-mutation wrapper exposes exactly `volume`, `credential`, and
`variables`. It accepts no service ID, environment, mount, variable name,
variable value, or credential from the caller. `variables` sends all eleven
fixed values in one ordered `railway variable set` command; it is never an
eleven-command loop. `password` generates exactly 32 bytes with Node's CSPRNG,
encodes them to a base64url buffer without placing the value in an argument or
JavaScript string, sends that buffer only through stdin, then wipes both
buffers best-effort.

All mutating wrappers require the exact isolated link with `Service: None`,
have a 30-second child-process timeout, suppress or strictly bound and wipe
child diagnostics, reject ambient `ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN`,
`RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`, and `RAILWAY_PROJECT_TOKEN`, and report
that a fresh schema-locked projection is still required. Child environments
are allowlisted to OS path, temporary-directory, home, and credential-store
location fields; provider keys, database/Redis URLs, application credentials,
and unrelated environment values are not forwarded. The configuration wrapper
sends its fixed patch through stdin and requires one exact committed
acknowledgement line.

## Shared live preconditions

Before either R3B gate:

1. Require Railway CLI `4.30.2` and the reviewed `railway.exe` SHA-256
   `87C3047C7F4A7E8162ED4783592460A226DA322074005BAF1351532A360E5D73`.
2. Use an isolated temporary Railway link and require the exact project,
   environment, and `Service: None`.
3. Use one temporary environment-scoped project token only in the reviewed
   secure projector process, then revoke it immediately.
4. Require one exact R3 service and service instance with no ambiguity or
   deletion marker.
5. Require the exact private network to be the sole active private network.
6. Require a fresh exact-ID R3 TCP-proxy count of `0`.
7. Require all Railway and custom domain counts to be `0`.
8. Require the original PostgreSQL and Redis, PostgreSQL R2, and Redis R2 to
   remain offline, unchanged, and unexposed.
9. Require both validators offline and no target-environment web, worker,
   Python, bridge, daemon, or executor instance.
10. Capture sanitized production and Phase 2D stable identities for a later
   non-impact comparison.

Missing, ambiguous, stale, or nonzero evidence stops the gate without repair.

## R3B1 — offline preparation

R3B1 may authorize only these ordered mutations against the fixed R3 service:

1. Create and attach one fresh environment-local volume at
   `/var/lib/postgresql/data`.
2. Generate one independent 32-byte CSPRNG `POSTGRES_PASSWORD` entirely in
   memory and set it through stdin with deployment suppressed.
3. Set exactly these eleven fixed non-secret or Railway-reference variables in
   one ordered batch command with deployment suppressed:
   `POSTGRES_USER`, `POSTGRES_DB`, `PGDATA`, `PGHOST`, `PGPORT`, `PGUSER`,
   `PGPASSWORD`, `PGDATABASE`, `DATABASE_URL`, `SSL_CERT_DAYS`, and
   `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`.
4. Apply only the `service-configuration` profile through the committed
   PostgreSQL-only wrapper.

The only executable entry points for those four steps are:

```text
node scripts/gate-r1-postgres-r3-offline-mutation.js --operation volume
node scripts/gate-r1-postgres-r3-offline-mutation.js --operation credential
node scripts/gate-r1-postgres-r3-offline-mutation.js --operation variables
node scripts/gate-r1-postgres-r3-config-patch.js --profile service-configuration
```

Do not execute the historical R2 runbook commands.

R3B1 must stop while `sourceKind` remains `NONE`. It must not assign an image,
start a deployment, run readiness, connect to PostgreSQL, run SQL, activate
Redis, or apply a migration.

After every mutation, require a fresh allowlisted metadata projection. At the
R3B1 stop boundary require exactly one fresh volume with the exact mount,
exactly the twelve allowed variable names, no public-URL name, the fixed restart
policy, no source or deployment, and zero domains and TCP proxies.

An ambiguous volume, variable, or patch response is not retry authorization.
Leave the partial R3 identity offline and request separate containment or
recovery authority.

### R3B1 projector-session ledger

The target-bound secure projector session has `MaximumRequests=20` and uses
exactly 15 requests when R3B1 succeeds:

| Request | Read-only operation |
|---:|---|
| 1 | Target-environment metadata |
| 2–3 | Original PostgreSQL and Redis fixed proxy counts |
| 4–5 | PostgreSQL R2 and Redis R2 replacement proxy counts |
| 6 | Exact PostgreSQL R3 proxy count |
| 7–8 | Metadata and exact R3 proxy after volume mutation |
| 9–10 | Metadata and exact R3 proxy after credential mutation |
| 11–12 | Metadata and exact R3 proxy after the one batch-variable mutation |
| 13–14 | Metadata and exact R3 proxy after the service-configuration patch; these are also the final stop-state proof |
| 15 | Stop and acknowledge the session before token revocation |

The five unused requests confer no authority for additional reads or
mutations. R3B1 performs no endpoint query; an active private endpoint and
readiness belong to R3B2. Production and Phase 2D stable-identity reads occur
outside this target-bound session.

The secure session mechanically enforces the schema, monotonically increasing
sequence, target allowlist, and 20-request ceiling. This R3B1 operation order
is an operator-enforced release procedure, not a new control-plane
orchestrator. Deviating from the ledger is a gate failure and does not grant a
replacement request.

If any mutation response is failed, partial, or ambiguous, run only its
required metadata-plus-R3-proxy evidence pair when the session remains safe,
then stop without retry or the next mutation. If either projector fails, stop
and revoke immediately. If CLI `4.30.2` cannot preserve the eleven fixed
variables as one bounded command, R3B1 is blocked before mutation.

The volume operation is intentionally one-shot and has no automatic retry.
The pre-mutation projection must show zero R3 volumes. Once the command starts,
a timeout, lost response, or process interruption is ambiguous even if no
volume identity was returned; the same command must not be invoked again under
this authorization. A fresh projection and separate recovery authorization are
required.

## R3B2 — source activation and readiness

R3B2 requires a separate reviewed commit and explicit authorization after R3B1
passes. It must repeat all shared preconditions, validate the complete R3B1
state, then introduce and apply one exact source-assignment operation. That
future operation must assign only the pinned image and be the only allowed
deployment trigger; do not run `railway up`, redeploy, or restart.

The R3B2 acceptance boundary requires one successful deployment using the
pinned image, the exact volume, exact variable-name set, an active private
endpoint, zero domains and TCP proxies, and a bounded authenticated non-SQL
`psql \conninfo` readiness result. Retained resources and production/Phase 2D
stable identities must remain unchanged.

If source assignment may have occurred and activation, exposure, or readiness
fails, stop. A future authorization may permit at most one exact-target
`railway down`; it does not imply repair, retry, deletion, networking mutation,
Redis activation, or migration authority.

## Current stop state

Until R3B1 is separately authorized, the R3 service remains empty, source-less,
undeployed, without a volume or variables, and untouched after R3A.
