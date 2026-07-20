# ARCANOS Phase 2E — Gate R1 PostgreSQL R3B2 Authorization Request

Copy-ready operator request. Submitting this text authorizes only the bounded
PostgreSQL R3B2 operation below.

## Authorization request

Authorize ARCANOS Phase 2E Gate R1 PostgreSQL R3B2 source activation and
readiness validation only.

Reviewed code-bearing commit:

```text
13442a020588ac7d42e1d724441cfb2438367d65
```

Preserved R3B1 evidence commit:

```text
3905ab7d9a31537b8043c118ab3b2010ef3d88da
```

Require the reviewed commit history, a clean worktree, Railway CLI `4.30.2`,
and Railway executable SHA-256:

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
```

### Authorized access-control and read-only work

- Create at most one temporary environment-scoped project token out of band.
- Inject it only into the reviewed secure projector process.
- Use a maximum-20-request projector session and the exact 15-request success
  ledger below.
- Read only schema-locked target metadata, TCP-proxy counts, private-endpoint
  state, deployment state, and production/Phase 2D stable identities.
- Revoke the temporary token immediately after the session stops, clear it from
  the process environment, and record revocation confirmation without recording
  the value or a fingerprint.

Do not read or print variable values, connection strings, raw logs, credentials,
public endpoints, request payloads, or broad Railway configuration.

### Mandatory live preconditions

Before source assignment, prove from fresh projections that:

- The exact project, environment, private network, service, service instance,
  volume, and volume instance match the IDs above.
- R3 remains source-less, repository-less, undeployed, and has no active
  deployment.
- The volume is `READY` at `/var/lib/postgresql/data`.
- The exact 12 approved variable names are present:
  `DATABASE_URL`, `PGDATA`, `PGDATABASE`, `PGHOST`, `PGPASSWORD`, `PGPORT`,
  `PGUSER`, `POSTGRES_DB`, `POSTGRES_PASSWORD`, `POSTGRES_USER`,
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS`, and `SSL_CERT_DAYS`.
- No public-URL variable is present.
- Restart policy is `ON_FAILURE` with maximum retries `3`.
- Railway-domain, custom-domain, and TCP-proxy counts are all zero.
- Original PostgreSQL, original Redis, PostgreSQL R2, and Redis R2 remain
  offline and unchanged with zero TCP proxies.
- `ARCANOS V2`, `ARCANOS Worker`, both validators, Python daemons, bridges, and
  executors remain inactive in the target environment.
- Production and Phase 2D stable service/deployment identities match their
  preserved baselines.

Missing, stale, ambiguous, or contradictory evidence stops the operation.

### Sole authorized mutation

Invoke exactly once:

```text
node scripts/gate-r1-postgres-r3-source-activation.js --operation activate
```

This is the only deployment trigger authorized. Do not run `railway up`,
redeploy, restart, `--service-config`, a second source assignment, an arbitrary
environment patch, or any Redis operation. A nonzero, timeout, lost response,
process interruption, or other ambiguous result consumes the one attempt and
does not authorize a retry.

### Bounded deployment and readiness validation

After the immediate post-source projections, invoke exactly once:

```text
node scripts/gate-r1-postgres-r3-deployment-status.js --operation wait --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89
```

The wrapper allows at most 120 observations, fixed five-second sleeps, and a
600,000 ms monotonic deadline. It must latch the first non-null deployment ID
and fail on terminal, stopped, malformed, changed, missing-after-latch, or
timed-out state. Parse its JSON structurally in memory. Require code
`GATE_R1_R3_DEPLOYMENT_SUCCEEDED`, status `PASS`, and one canonical deployment
UUID. Do not ask the operator to copy or retype the ID.

Use that exact in-memory ID for both verification calls:

```text
node scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id <latched-id>
```

Run the first verification only after request 9 metadata proves the latched ID
is the sole active R3 deployment, request 10 proves zero proxies, and request 11
proves the exact active private endpoint. Then invoke readiness exactly once:

```text
node scripts/gate-r1-postgres-readiness.js --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89
```

Require the fixed safe readiness success. Immediately rerun `verify-success`
with the same latched ID, then complete the final metadata, proxy, and endpoint
proofs. Readiness is service-targeted rather than deployment-instance-targeted;
the pre/post checks make rollover fail closed but do not make the SSH boundary
atomic. The approved `18.4` source is tag-pinned, not digest immutable; report
that limitation without weakening the exact-source-string check.

### Exact successful projector-session ledger

```text
1     target metadata and complete R3B1-state validation
2–6   original PostgreSQL, original Redis, PostgreSQL R2, Redis R2, R3 proxy proofs
—     source-activation wrapper exactly once
7     immediate post-source target metadata
8     immediate post-source R3 proxy proof
—     bounded wait wrapper; structurally retain its deployment ID
9     post-success metadata; require the latched ID as the sole active R3 deployment
10    post-success R3 proxy proof
11    post-success R3 private-endpoint proof
—     exact-ID verify-success
—     readiness wrapper exactly once
—     exact-ID verify-success again
12    final target metadata and retained-resource/non-impact proof
13    final R3 proxy proof
14    final R3 private-endpoint proof
15    stop and acknowledge the secure session
—     revoke the temporary token and clear the process environment
```

Request 12 covers target-environment non-impact. Production and Phase 2D
stable-identity comparison reads occur outside the target-bound projector
session, remain read-only, and do not consume its request ledger.

### Failure and abort contract

R3B2 authorizes no containment mutation. On any post-source failure or
ambiguity:

1. Perform only the next safe bounded projection needed to record current state.
2. Stop and acknowledge the projector session.
3. Revoke the temporary token and clear it from the process environment.
4. Do not retry, repair, run `railway down`, clear the source, deploy again, or
   continue the success ledger.
5. Return the sanitized state and latched deployment ID, when one exists, for a
   separately approved containment gate.

Railway CLI `down` targets the most recent service deployment rather than an
immutable deployment ID, so it is intentionally outside this authorization.

### Explicitly not authorized

- PostgreSQL containment, restart, redeploy, deletion, or source clearing.
- Any Redis source assignment, activation, readiness, mutation, or deployment.
- Migrations, SQL, Redis commands, application connections, data access, or
  provider calls.
- Application, worker, validator, daemon, bridge, or executor deployment.
- Gate R2, Gate V, Gate M, Gate D, or any later gate.
- Production or Phase 2D mutation.
- Credential retrieval, display, reuse, rotation, or application configuration.
- Domain or TCP-proxy creation or deletion.
- Git push, pull request, merge, or repository-source changes.

### Required return

Return a sanitized R3B2 evidence artifact, independent review, exact deployment
ID/status evidence, readiness result, disclosure scan, retained-resource proof,
production/Phase 2D non-impact proof, token revocation confirmation, worktree
status, and the next separately bounded authorization request. Stop after R3B2.
