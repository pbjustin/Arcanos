# ARCANOS Phase 2E — Gate R1 Redis R2 Activation and Readiness Authorization Request

Copy-ready operator request. Submitting this text authorizes only the bounded
Redis R2 configuration, source activation, deployment observation, and
authenticated readiness operation defined below.

## Authorization request

Authorize ARCANOS Phase 2E Gate R1 Redis R2 configuration, source activation,
and authenticated readiness validation only.

Reviewed Redis code-bearing commit:

```text
b510a976e09e5ff8e153535d76bdd8da6d69fb3f
```

Preserved PostgreSQL R3B3 readiness-pass evidence commit:

```text
4c8d5c7650ace6a511f04b99680b560cee73c117
```

Require that commit in the current branch history, a clean worktree, Railway
CLI `4.30.2`, and Railway executable SHA-256:

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
Redis R2 service: phase2e-redis-r2-20260718
Service ID: 1ac0bd56-50b3-49eb-954c-ea83515ec915
Service-instance ID: 0f34bcbb-bfd0-4df5-954a-bb97371bd460
Volume ID: 983c4f0a-9180-4621-b65e-dfdd0b79f2bd
Volume-instance ID: b96f20a3-a1f1-40ea-ba4b-334ea3e8ba15
Volume mount: /data
Image: redis:8.2.1
```

PostgreSQL R3 must already retain its separately proven R3B3 readiness `PASS`,
including deployment `b5e45d34-19b8-4253-b230-c3ab0b60b0d7`. This request
does not authorize any PostgreSQL operation.

### Mandatory local preflight

Before creating or entering a temporary token:

- Verify the branch contains both commits above and the worktree is clean.
- Verify the four Redis R2 wrappers and their focused tests match the reviewed
  commit: configuration patch, source activation, deployment status, and
  readiness.
- Run all four focused Redis suites and require every test to pass.
- Require Railway CLI `4.30.2` and the executable digest above.
- Use an isolated temporary Railway link bound to the exact project and
  environment above with selected service `None`.
- Reject any ambient `RAILWAY_TOKEN`, `RAILWAY_API_TOKEN`,
  `RAILWAY_PROJECT_TOKEN`, or `ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN` before
  starting the reviewed projector session or a mutation wrapper.

Any mismatch stops before a token is created or a Railway mutation occurs.

### Secure read-only projector session

- Create at most one temporary environment-scoped Railway project token out of
  band.
- Enter it only into the reviewed secure projector-session prompt. Never place
  it in a command argument, ordinary shell variable, transcript, file, log,
  evidence artifact, hash, or fingerprint.
- Use only the exact 16-request ledger below, within the session's maximum of
  20 requests.
- Require every request and response to use the session's schema-locked JSON
  contract and exact monotonic sequence number.
- Stop and acknowledge the session, revoke the token immediately, clear it from
  the process environment, and record only revocation confirmation.

Do not read or print variable values, connection strings, endpoint hostnames,
raw logs, raw Railway responses, credentials, or broad environment
configuration.

### Initial Redis R2 proof

Use the first three schema-locked projector requests to prove:

- Exact project, environment, private network, Redis service, service instance,
  volume, and volume-instance identities.
- Redis R2 is not deleted, has no repository source, no source image, no latest
  deployment, and no active deployment.
- The fresh volume is `READY` at `/data`.
- The exact six approved variable names are present: `REDISHOST`,
  `REDISPASSWORD`, `REDISPORT`, `REDISUSER`, `REDIS_PASSWORD`, and `REDIS_URL`.
- No `REDIS_PUBLIC_URL`, other public-URL variable, shared variable, or
  unapproved variable name is present.
- Railway-domain count, custom-domain count, and TCP-proxy count are all zero.
- The exact Redis private endpoint exists and reports `ACTIVE` on private
  network `464f2194-3825-4ac1-a705-192566561675`.
- The exact PostgreSQL R3 deployment remains the sole active replacement data
  deployment and retains its R3B3 `PASS` state.
- Original PostgreSQL, original Redis, PostgreSQL R2, applications, worker,
  validators, Python daemon, bridge, and executors remain offline or inactive
  as their preserved evidence requires.

Missing, stale, ambiguous, or contradictory evidence stops the operation.

### Sole authorized configuration mutation and projection

Invoke the fixed Redis-only configuration profile exactly once:

```text
node scripts/gate-r1-redis-r2-config-patch.js --profile service-configuration
```

It may set only:

- `restartPolicyType=ON_FAILURE`;
- `restartPolicyMaxRetries=3`; and
- the exact reviewed Redis start-command contract.

Require fixed code
`GATE_R1_REDIS_CONFIG_PATCH_ACCEPTED_PENDING_PROJECTION`. Then perform exactly
one configuration-acceptance metadata projection. Require Redis R2 still to be
source-less and undeployed, with restart policy `ON_FAILURE`, maximum retries
`3`, and `startCommandContract=APPROVED_REDIS`. Also repeat the exact Redis
proxy and private-endpoint projections before source activation and require
zero proxies and the same active private endpoint.

A nonzero, timeout, lost response, malformed acknowledgement, mismatch, or
ambiguous configuration result consumes the one configuration attempt. Do not
repeat the patch and do not activate the image.

### Sole authorized source mutation

Only after the configuration projection and exposure checks pass, invoke
exactly once:

```text
node scripts/gate-r1-redis-r2-source-activation.js --operation activate
```

Require fixed code
`GATE_R1_REDIS_SOURCE_ACTIVATION_ACCEPTED_PENDING_PROJECTION`. This is the sole
authorized Redis deployment trigger. Do not run `railway up`, redeploy,
restart, `down`, a second source assignment, an arbitrary environment patch,
or any PostgreSQL operation.

Immediately project target metadata, Redis proxy count, and private-endpoint
state. Require the exact approved image string, no repository source, zero
domains, zero proxies, and the same private endpoint. A post-activation failure
or ambiguity consumes the source attempt and does not authorize a retry or
containment.

### Bounded deployment-ID latch

Invoke the deployment waiter exactly once:

```text
node scripts/gate-r1-redis-r2-deployment-status.js --operation wait --service-id 1ac0bd56-50b3-49eb-954c-ea83515ec915
```

The wrapper permits at most 120 observations, fixed five-second sleeps, and a
600,000 ms monotonic deadline. It must latch the first non-null deployment ID
and fail on a terminal, stopped, malformed, changed, missing-after-latch, or
timed-out state. Parse the fixed JSON structurally in memory and require:

```text
code: GATE_R1_REDIS_DEPLOYMENT_SUCCEEDED
status: PASS
deploymentId: one canonical UUID
```

Do not ask the operator to copy or retype the deployment ID. Use the same
in-memory ID for both exact verification calls:

```text
node scripts/gate-r1-redis-r2-deployment-status.js --operation verify-success --service-id 1ac0bd56-50b3-49eb-954c-ea83515ec915 --deployment-id <latched-id>
```

After the wait, require fresh metadata to show the latched ID as the sole
active Redis R2 deployment, status `SUCCESS`, `stopped: false`, the exact source
string, the reviewed start-command contract, the retained fresh volume, zero
domains and proxies, and the active private endpoint. Then run the first exact-
ID verification.

### Sole authenticated readiness invocation

Invoke exactly once:

```text
node scripts/gate-r1-redis-readiness.js --service-id 1ac0bd56-50b3-49eb-954c-ea83515ec915
```

Require fixed code `GATE_R_REDIS_AUTHENTICATED_READINESS_PASSED` and status
`PASS`. The wrapper checks the exact Railway target inside the container, uses
the service-local password only through `REDISCLI_AUTH`, sends only `PING`,
requires exact `PONG`, suppresses child stdout and stderr, and performs no Redis
data read or write.

Immediately rerun `verify-success` with the same latched deployment ID and then
repeat target metadata, Redis proxy, and private-endpoint projections. Require
the same deployment, service instance, volume, configuration, private endpoint,
and zero-exposure state.

Readiness is service-targeted rather than deployment-instance-targeted. The
exact-ID checks and pre/post projections make rollover fail closed but do not
make the SSH boundary atomic.

### Exact successful projector-session ledger

```text
1   initial target metadata and complete Redis R2/offline-state proof
2   initial Redis R2 replacement TCP-proxy proof
3   initial Redis R2 private-endpoint proof
—   Redis service-configuration wrapper exactly once
4   sole configuration-acceptance metadata projection
5   pre-activation Redis R2 replacement TCP-proxy proof
6   pre-activation Redis R2 private-endpoint proof
—   Redis source-activation wrapper exactly once
7   immediate post-source target metadata
8   immediate post-source Redis R2 replacement TCP-proxy proof
9   immediate post-source Redis R2 private-endpoint proof
—   bounded deployment waiter; structurally retain its deployment ID
10  post-success target metadata; require the latched ID as sole active deployment
11  post-success Redis R2 replacement TCP-proxy proof
12  post-success Redis R2 private-endpoint proof
—   exact-ID verify-success
—   authenticated readiness wrapper exactly once
—   exact-ID verify-success again
13  final target metadata and retained-resource/non-impact proof
14  final Redis R2 replacement TCP-proxy proof
15  final Redis R2 private-endpoint proof
16  stop and acknowledge the secure projector session
—   revoke the temporary token and clear the process environment
```

No additional projector request is authorized. Production and Phase 2D stable-
identity comparisons, if required for the final evidence, must use already
reviewed read-only metadata paths outside this target-bound session and must not
select either environment for mutation.

### Supply-chain and process-argument limitations

- `redis:8.2.1` is tag-pinned, not digest-immutable. Require the exact approved
  source string and record a resolved deployment/image digest only if an
  already-reviewed safe projection exposes it; do not claim digest-level
  reproducibility when it does not.
- The reviewed start command passes `--requirepass "$REDIS_PASSWORD"` through a
  shell before `exec`. The stored Railway configuration contains an environment
  reference rather than a credential value, but the running Redis process may
  receive the resolved credential in its process arguments. This gate does not
  inspect process listings and does not eliminate visibility to a sufficiently
  privileged in-container or platform observer. Record this as a residual
  limitation for a separately designed credential-delivery hardening phase.
- The readiness wrapper does not add the credential to its `redis-cli` command
  arguments; it uses `REDISCLI_AUTH` and discards child output.

These limitations do not authorize changing the image, start command,
credential mechanism, or Redis architecture during this gate.

### Failure, no-retry, and no-containment contract

Any fixed failure, timeout, interruption, ambiguous response, lost response,
identity mismatch, deployment rollover, exposure mismatch, or readiness
failure stops Gate R1. It authorizes no retry or containment mutation.

On failure:

1. Perform only the next already-authorized bounded projection needed to record
   current state, provided no projector query has already failed.
2. Stop and acknowledge the projector session.
3. Revoke the temporary token immediately and clear the process environment.
4. Do not repeat configuration, activation, waiting, deployment verification,
   or readiness.
5. Do not run `railway down`, restart, redeploy, clear the source, change
   configuration, disable the deployment, delete anything, or continue the
   success ledger.
6. Return sanitized state and the latched deployment ID, if one exists, for a
   separately approved decision.

The waiter's bounded observations are one read operation, not authorization for
a second wait or source mutation.

### Explicitly not authorized

- PostgreSQL reads beyond the target metadata needed to prove retained state,
  or any PostgreSQL mutation, readiness, restart, deployment, SQL, or migration.
- Redis credential generation, retrieval, rotation, display, comparison, or
  variable-value reads.
- Redis data access or any command other than the readiness wrapper's bounded
  authenticated `PING`.
- Domain or TCP-proxy creation, deletion, or repair.
- Application, worker, validator, Python daemon, bridge, executor, scheduler,
  or provider deployment or startup.
- Application connection, ActionPlan operation, execution run, result
  submission, Gate R2, Gate V, Gate M, Gate D, Gate E, or any later gate.
- Production or Phase 2D mutation.
- Git source changes, push, pull request, merge, or deployment outside the one
  exact Redis source activation.

### Required return

Return a sanitized Redis R2 evidence artifact containing:

- Source branch, exact reviewed commit, and clean-worktree proof.
- Focused Redis test counts, CLI version, and Railway executable-digest match.
- Exact service, service-instance, volume, volume-instance, source, and latched
  deployment identities.
- The single configuration mutation result and sole configuration-acceptance
  projection.
- Pre/post metadata, proxy count, private-endpoint state, and exact deployment
  verification results.
- Readiness attempt count `1` and the fixed readiness result.
- Confirmation that one source activation affected only Redis R2 and that no
  PostgreSQL, application, worker, validator, daemon, executor, migration, data,
  ActionPlan, or provider operation occurred.
- Secret, connection-string, raw-variable, child-output, and payload disclosure
  counts, all expected to be zero.
- Secure-session stop/acknowledgement, environment clearing, and token-
  revocation confirmation.
- Explicit recording of the tag-pinning and process-argument limitations.
- Independent review and production/Phase 2D non-impact evidence.

Classify this Redis R2 operation as `PASS` only when every configuration,
deployment, readiness, exposure, and post-state invariant passes. Otherwise
classify it `BLOCKED`, preserve the observed state, and request a separate
authorization. Stop after the Redis R2 evidence is complete.
