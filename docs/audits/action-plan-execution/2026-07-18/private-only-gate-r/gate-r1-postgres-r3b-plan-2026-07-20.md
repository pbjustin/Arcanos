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

R3B1 is preserved in
`gate-r1-postgres-r3b1-execution-evidence-2026-07-20.json` as
`PASS_WITH_LIMITATIONS`. R3B2 must treat that artifact and a fresh live
projection as cumulative prerequisites. The projected state, not the invalid
R3B1 configuration-wrapper acknowledgement, is the evidence that the fixed
restart policy is present. R3B2 does not reinterpret or retry the historical
R3B1 operation.

R3B2 requires a separate reviewed commit and explicit live authorization. It
must repeat all shared preconditions, validate the complete R3B1 state, and use
only these target-bound entry points:

```text
node scripts/gate-r1-postgres-r3-source-activation.js --operation activate
node scripts/gate-r1-postgres-r3-deployment-status.js --operation wait --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89
node scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id <deployment-id-returned-by-wait>
node scripts/gate-r1-postgres-readiness.js --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89
```

The source-activation wrapper assigns only
`ghcr.io/railwayapp-templates/postgres-ssl:18.4` to the exact R3 service. It is
one-shot, reports only that fresh projection is required, and is the only
allowed deployment trigger. Do not use `railway up`, redeploy, restart,
`--service-config`, an arbitrary environment patch, or any second source
assignment. A timeout, nonzero result, lost response, or other ambiguous source
result consumes the one attempt and is not retry authorization.

The deployment-status wrapper's fixed `wait` operation is read-only. It makes
at most `120` observations with a fixed five-second sleep between observations,
and has a ten-minute monotonic overall deadline. It latches the first non-null
deployment ID and fails immediately if that ID
changes or disappears. Terminal, stopped, malformed, unexpected, or timed-out
states exit nonzero. Only `SUCCESS` advances the procedure. Its fixed
`verify-success` operation requires the returned deployment ID, exact
`SUCCESS`, and `stopped: false`. Neither operation fetches raw logs or variable
values. The existence of a successful deployment does not replace the later
source, volume, variable-name, restart-policy, endpoint, exposure, readiness,
or non-impact proofs.

The existing PostgreSQL readiness wrapper may run exactly once and only after
the successful deployment, the first post-success metadata, proxy, and
private-endpoint proofs, and an expected-ID `verify-success` call pass. Run the
same expected-ID verification again immediately after readiness and before the
final metadata proof. The readiness command is service-targeted rather than
deployment-instance-targeted; the surrounding checks make a rollover fail
closed but cannot make the SSH boundary atomic. The wrapper performs the
bounded authenticated non-SQL `psql \conninfo` check with suppressed child
output and fixed diagnostics. Do not replace it with direct or verbose
`railway ssh`, `psql`, or log inspection.

R3B2 authorizes no containment mutation. On any post-source failure or
ambiguity, stop at the next safe read, stop and acknowledge the projector
session, revoke the temporary token, and report the latched deployment ID when
one exists. Do not retry, repair, run `railway down`, clear the source, or
continue the success ledger. Containment requires a separate gate because
Railway CLI `down` targets the most recent service deployment rather than an
immutable deployment ID.

### R3B2 projector-session ledger

A successful R3B2 run uses exactly 15 requests in the target-bound secure
projector session:

| Request | Read-only operation or intervening controlled step |
|---:|---|
| 1 | Target-environment metadata and complete R3B1-state validation |
| 2–6 | Original PostgreSQL, original Redis, PostgreSQL R2, Redis R2, and exact PostgreSQL R3 proxy proofs |
| — | Invoke the source-activation wrapper exactly once |
| 7 | Immediate post-source target-environment metadata |
| 8 | Immediate post-source exact R3 proxy proof |
| — | Invoke the deployment-status wrapper, at most 120 polls with a five-second interval, until `SUCCESS` or fail closed |
| 9 | Post-success target-environment metadata |
| 10 | Post-success exact R3 proxy proof |
| 11 | Post-success exact R3 private-endpoint proof |
| — | Verify exact expected deployment ID and `SUCCESS` immediately before readiness |
| — | Invoke the existing authenticated readiness wrapper exactly once |
| — | Verify exact expected deployment ID and `SUCCESS` immediately after readiness |
| 12 | Final target-environment metadata and retained-resource proof |
| 13 | Final exact R3 proxy proof |
| 14 | Final exact R3 private-endpoint proof |
| 15 | Stop and acknowledge the secure session, then revoke the temporary token |

Deployment-status polling and the two expected-ID verifications are outside
the secure projector request count and authorize no mutation. On a failed or
ambiguous path, stop and acknowledge the projector session at the next safe
request, revoke the token, and do not consume the remaining success-path ledger
as repair or containment authority.

Request 9 metadata must show the latched deployment ID as the sole active R3
deployment before any endpoint or readiness check proceeds.

The R3B2 acceptance boundary requires exactly one new successful deployment
using the approved image, the R3B1 volume
`ce93ced0-0c15-48f9-87fc-d9153ffefdc8` and volume instance
`c7969acf-79fd-4a6b-83d7-1e6cb442a030`, the exact twelve-name variable set,
restart policy `ON_FAILURE` with maximum retries `3`, an active private
endpoint, zero Railway and custom domains, zero TCP proxies, and the successful
readiness result. Retained resources and production/Phase 2D stable identities
must remain unchanged. The final metadata projection must still show exactly
the latched deployment ID as the sole active R3 deployment.

The approved `18.4` source is version-tag pinned, not digest immutable.
Metadata must prove the exact approved source string, but this gate does not
claim registry-content immutability. The pre/post-readiness deployment-ID
checks bound the observed service deployment but do not make the service-
targeted readiness connection atomic.

R3B2 does not authorize Redis source assignment, activation, mutation,
readiness, containment, or deployment. It also does not authorize migrations,
SQL, application connections, validators, workers, daemons, executors,
providers, Gate R2/V/M/D, production, or Phase 2D mutation.

## Current stop state

R3B1 completed with the limitation recorded in
`gate-r1-postgres-r3b1-execution-evidence-2026-07-20.json`. The exact R3 service
remains source-less and undeployed with one `READY` volume at
`/var/lib/postgresql/data`, the exact twelve approved variable names, restart
policy `ON_FAILURE` with maximum retries `3`, and zero Railway domains, custom
domains, and TCP proxies. The temporary projector token was revoked. The
configuration-wrapper result remains invalid historical evidence even though
the fresh schema-locked projection proved the intended configuration; it was
not retried or relabeled.

R3B2 execution remains unauthorized. Local R3B2 preparation changes no Railway
state, and Redis remains offline and untouched.
