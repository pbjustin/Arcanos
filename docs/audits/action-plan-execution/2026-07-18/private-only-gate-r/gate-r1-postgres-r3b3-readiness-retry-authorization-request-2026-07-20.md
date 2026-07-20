# ARCANOS Phase 2E — Gate R1 PostgreSQL R3B3 Readiness Retry Authorization Request

Copy-ready operator request. Submitting this text authorizes only one corrected,
authenticated, non-SQL readiness check against the already-running PostgreSQL
R3 deployment identified below. It does not authorize any Railway mutation.

## Authorization request

Authorize ARCANOS Phase 2E Gate R1 PostgreSQL R3B3 corrected readiness retry
only.

Reviewed corrective commit:

```text
537c94b52e031c0cf6ec11ce1902e46e1689b7c0
```

Preserved historical R3B2 readiness-failure evidence commit:

```text
335154d86bdc7911cdb487c4a2110f178aab27f9
```

Require the reviewed corrective commit, a clean worktree, Railway CLI
`4.30.2`, and Railway executable SHA-256:

```text
87C3047C7F4A7E8162ED4783592460A226DA322074005BAF1351532A360E5D73
```

Exact Railway target:

```text
Project: Arcanos
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment: phase2e-validation-20260717
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13
Private network ID: 464f2194-3825-4ac1-a705-192566561675
PostgreSQL R3 service: phase2e-postgres-r3-20260720
Service ID: 7346b3f6-bf3d-46e1-9d66-79f10847ef89
Service-instance ID: 86dde430-50ac-4d5c-95c3-cb27064eff51
Volume ID: ce93ced0-0c15-48f9-87fc-d9153ffefdc8
Volume-instance ID: c7969acf-79fd-4a6b-83d7-1e6cb442a030
Image: ghcr.io/railwayapp-templates/postgres-ssl:18.4
Existing deployment ID: b5e45d34-19b8-4253-b230-c3ab0b60b0d7
```

### Purpose and historical boundary

R3B2 successfully activated the exact image and produced the exact successful
deployment above. Its sole readiness invocation failed safely with:

```text
GATE_R_POSTGRES_READINESS_REMOTE_TARGET_MISMATCH
```

That result remains historical evidence and must not be relabeled or rewritten.
The reviewed correction removes only the redundant nested shell layer added by
the wrapper. It retains the exact `railway ssh` target, fixed remote checks,
authenticated `psql \conninfo`, bounded timeout, suppressed child streams, and
fixed non-sensitive outcomes.

### Mandatory local preflight

Before any live read:

- Verify the branch contains commit
  `537c94b52e031c0cf6ec11ce1902e46e1689b7c0` and the worktree is clean.
- Verify `scripts/gate-r1-postgres-readiness.js` and its focused tests match that
  commit exactly.
- Run the focused PostgreSQL readiness tests and require all 20 tests to pass.
- Run the Gate R1 local test sweep and require all 355 tests to pass.
- Require the Railway CLI version and executable digest shown above.
- Use an isolated temporary Railway link whose project and environment match the
  exact IDs above and whose selected service is `None`.
- Confirm no Railway mutation command is queued, running, or implied by the
  procedure.

Any mismatch stops the operation before a token is created or entered.

### Authorized token handling and schema-locked reads

- Create at most one temporary environment-scoped project token out of band.
- Inject it only into the reviewed secure projector session.
- Do not print, log, persist, fingerprint, or pass the token on a command line.
- Use the existing maximum-20-request session cap, but submit only the exact
  seven-request ledger below.
- Revoke the token immediately after the session stops, clear it from the
  process environment, and record only the revocation confirmation.

The only authorized projector reads are the exact PostgreSQL R3 target metadata,
TCP-proxy count, and private-endpoint state, once before and once after the
readiness check.

### Exact pre-readiness proof

Run these schema-locked queries once each:

```text
node scripts/gate-r1-railway-metadata-projector.js --environment
```

```text
node scripts/gate-r1-tcp-proxy-projector.js --replacement-profile postgres-r3 --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --service-instance-id 86dde430-50ac-4d5c-95c3-cb27064eff51
```

```text
node scripts/gate-r1-railway-metadata-projector.js --endpoint --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --service-name phase2e-postgres-r3-20260720 --private-network-id 464f2194-3825-4ac1-a705-192566561675
```

Require all of the following before readiness:

- Exact project, environment, private network, service, service instance,
  volume, and volume-instance IDs.
- Exact image `ghcr.io/railwayapp-templates/postgres-ssl:18.4` and no repository
  source.
- Exact deployment ID `b5e45d34-19b8-4253-b230-c3ab0b60b0d7`, status
  `SUCCESS`, `stopped: false`, and exactly one active deployment.
- Volume state `READY` at `/var/lib/postgresql/data`.
- The exact 12 approved variable names: `DATABASE_URL`, `PGDATA`, `PGDATABASE`,
  `PGHOST`, `PGPASSWORD`, `PGPORT`, `PGUSER`, `POSTGRES_DB`,
  `POSTGRES_PASSWORD`, `POSTGRES_USER`,
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and `SSL_CERT_DAYS`.
- No public-URL variable.
- Restart policy `ON_FAILURE` with maximum retries `3`.
- Railway-domain count `0`, custom-domain count `0`, and TCP-proxy count `0`.
- One active private endpoint on private network
  `464f2194-3825-4ac1-a705-192566561675`.
- No application, worker, validator, daemon, bridge, executor, migration, or
  ActionPlan operation started in the target environment.

Then verify the already-known deployment once, without polling or waiting:

```text
node scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id b5e45d34-19b8-4253-b230-c3ab0b60b0d7
```

Require the exact deployment ID, `SUCCESS`, `stopped: false`, and a fixed safe
`PASS` result. A stale, missing, changed, stopped, or ambiguous deployment stops
the operation before readiness.

### Sole authorized readiness invocation

Invoke exactly once:

```text
node scripts/gate-r1-postgres-readiness.js --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89
```

This is the sole live readiness attempt. It is an authenticated, non-data-
mutating `psql \conninfo` check executed inside the exact Railway service. It
must not run SQL, print connection information, or retain child output.

Any nonzero result, timeout, interruption, ambiguous response, or lost response
consumes the one attempt. It does not authorize a retry, shell inspection,
source activation, redeployment, restart, repair, or replacement.

### Exact post-readiness proof

Regardless of readiness success or safe failure, rerun the exact-ID
`verify-success` command once, then repeat the same three schema-locked metadata,
TCP-proxy, and private-endpoint queries once each. Require:

- The same sole deployment ID and `SUCCESS` status.
- `stopped: false`.
- The same exact image and service-instance identity.
- The same volume ID, volume-instance ID, mount, and `READY` state.
- Railway-domain count `0`, custom-domain count `0`, and TCP-proxy count `0`.
- The same active private endpoint and private-network ID.
- No source, configuration, restart-policy, variable-name, deployment-count, or
  consumer change.
- No application, worker, validator, daemon, bridge, executor, migration, SQL,
  Redis command, ActionPlan operation, or provider call.

If a post-readiness query fails, do not repeat readiness or any query. Stop the
projector session, revoke the token, and report the bounded failure.

### Exact projector-session ledger

```text
1  pre-readiness target metadata
2  pre-readiness PostgreSQL R3 TCP-proxy proof
3  pre-readiness PostgreSQL R3 private-endpoint proof
—  exact existing-deployment verify-success
—  corrected readiness wrapper exactly once
—  exact existing-deployment verify-success again
4  post-readiness target metadata
5  post-readiness PostgreSQL R3 TCP-proxy proof
6  post-readiness PostgreSQL R3 private-endpoint proof
7  stop and acknowledge the secure projector session
—  revoke the temporary token and clear the process environment
```

No additional projector request is authorized.

### Explicitly not authorized

- Source assignment, source activation, source clearing, configuration patching,
  image changes, or repository-source changes.
- `railway up`, deploy, redeploy, restart, `down`, scale, wait, rollback, or any
  other deployment mutation.
- A second readiness attempt or a direct `railway ssh` invocation.
- Any PostgreSQL service, deployment, volume, variable, credential, domain,
  proxy, or private-endpoint mutation.
- Any Redis read, readiness check, source assignment, deployment, or mutation.
- SQL, data reads, application connections, migrations, or schema changes.
- Application, worker, validator, daemon, bridge, executor, or provider startup.
- Gate R2, Gate V, Gate M, Gate D, or any later gate.
- Production or Phase 2D reads or mutations during this narrowly scoped retry.
- Raw logs, raw Railway variable output, resolved connection strings, public
  endpoints, credentials, secret fingerprints, or child-process output.
- Git source changes, push, pull request, merge, or deployment outside this
  authorization.

### Failure and stop contract

On any failure or ambiguity:

1. Do not retry readiness and do not perform a mutation.
2. Complete only the already-authorized post-readiness proof when it can be done
   safely and has not itself failed.
3. Stop and acknowledge the secure projector session.
4. Revoke the temporary token immediately and clear the process environment.
5. Preserve the historical R3B2 failure unchanged.
6. Return the fixed safe failure code and sanitized projected state for a new,
   separately approved decision.

### Required return

Return a sanitized R3B3 evidence artifact containing:

- Source branch, exact corrective commit, and clean-worktree proof.
- Local focused and Gate R1 test counts.
- CLI version and executable-digest match, without credential-store contents.
- Pre/post safe metadata, proxy counts, private-endpoint state, and exact
  deployment verification results.
- The single corrected readiness result and attempt count `1`.
- Confirmation that source activation, redeployment, restart, mutation, SQL,
  Redis activity, applications, migrations, and providers remained at zero.
- Secret, connection-string, raw-variable, and child-output disclosure counts,
  all expected to be zero.
- Secure-session stop, environment clearing, and token-revocation confirmation.
- Confirmation that the historical R3B2 artifact was not rewritten.

Classify R3B3 as `PASS` only if the corrected readiness check returns its fixed
safe success and every post-readiness invariant matches. Otherwise classify it
as `BLOCKED`, preserve the running deployment unchanged, and request a separate
authorization. Stop after R3B3.
