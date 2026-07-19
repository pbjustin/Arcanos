# Gate R1 private replacement execution authorization request

Status: **COPY-READY REQUEST — NOT AUTHORIZATION BY THIS DOCUMENT**

The current TCP-proxy precondition passed through authenticated Railway
dashboard observations recorded in
`gate-r1-dashboard-proxy-evidence-2026-07-19.json`. The selected environment
showed both compromised data services offline with their volumes retained. Each
service's Public Networking page showed only the inactive Public access
enablement option and no existing proxy host or port.

This observation must be repeated immediately before the first mutation. A
historical screenshot is not sufficient to start execution.

## Copy-ready operator authorization

```text
Authorize ARCANOS Phase 2E Gate R1 replacement execution only.

Target:
Project: Arcanos
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment: phase2e-validation-20260717
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13

Quarantined services that must remain unchanged:
PostgreSQL service: b7789306-8aef-4113-add5-02883a6cc087
PostgreSQL volume: 35c26093-1e3f-4d34-b699-89c65d2fb92d
Redis service: 434fa5b4-b52c-4caf-aaba-e87c173bf10d
Redis volume: d3690500-fcc5-4c06-afa6-cf30e91f608d

Mandatory precondition immediately before the first mutation:
- Reverify the exact project and environment through an isolated temporary Railway link.
- Reverify both quarantined services remain offline and their volumes remain attached.
- Require the dedicated ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN to be already present only in the projector process and prove its exact project/environment scope.
- Run the reviewed schema-locked environment metadata projector; prohibit raw variable and broad environment-config reads.
- Through the authenticated Railway dashboard, open each exact service's Public Networking page.
- Require only the inactive Public access enablement option and no existing proxy hostname or port.
- Require zero Railway-provided domains and zero custom domains.
- Stop if exact service identity, environment, or zero exposure cannot be proven.
- Do not create, retrieve, configure, print, or persist an API token under this authorization.

Authorized Gate R1 work:
- Create one empty service named phase2e-postgres-r2-20260718.
- Create one empty service named phase2e-redis-r2-20260718.
- Create and attach one fresh environment-local volume to each replacement.
- Mount PostgreSQL at /var/lib/postgresql/data.
- Mount Redis at /data.
- Generate independent 32-byte preview-only credentials entirely in memory.
- Configure only the reviewed service-local variable-name sets and private Railway references.
- Keep all deployment-triggering changes suppressed until the pre-activation isolation gate passes.
- Configure the reviewed bounded restart policies and Redis start command.
- Require zero domains, zero TCP proxies, zero public-URL variables, fresh volumes, and exactly one live private network before source activation.
- Activate PostgreSQL first with ghcr.io/railwayapp-templates/postgres-ssl:18.4.
- Run only the reviewed authenticated non-SQL psql \conninfo readiness wrapper.
- Activate Redis only after PostgreSQL passes, using redis:8.2.1.
- Perform authenticated, non-data-mutating Redis readiness according to the reviewed runbook.
- Prove each activated replacement has an ACTIVE private endpoint bound to its exact service instance.
- Remove an unexpectedly created replacement-only domain or proxy only through a reviewed exact-target operation; stop if safe removal is unavailable.
- Produce sanitized service, deployment, volume, health, credential-generation, and isolation evidence.
- Stop after both replacements are healthy and private-only.

Not authorized:
- Restarting, redeploying, changing, deleting, or detaching either quarantined service or volume.
- Using Railway database templates.
- Creating a public endpoint intentionally.
- Deploying ARCANOS V2, ARCANOS Worker, validators, daemons, bridges, or executors.
- Applying migrations, schema DDL, application SQL, or Redis data operations.
- Configuring requester, executor, provider, bridge, or application credentials.
- Connecting an application or copying old data.
- Using production, Phase 2D, or compromised credentials.
- Running Gate R2, Gate V, Gate M, or Gate D.
- Push, pull request, merge, production mutation, or Phase 2D mutation.
- Deleting any service, volume, or environment.

Immediate stop conditions:
- Target mismatch or ambiguous identity.
- Either quarantined service is active or restarted.
- Either replacement name already exists.
- Any replacement receives a domain, proxy, public-URL variable, source, or deployment before the reviewed gate permits it.
- Any credential value, connection string, resolved variable, or fingerprint appears in output or evidence.
- Any application, validator, daemon, executor, migration, SQL, Redis data, or provider operation occurs.
- Isolation, readiness, fresh-volume identity, or production/Phase 2D non-impact cannot be proven.

This authorization is Gate R1 only. Stop after replacement isolation is proven and return with evidence plus a separate Gate R2 proposal.
```

## Current disposition

```text
Gate R0: CORRECTIVE PASS WITH ONE EVIDENCE LIMITATION; quarantine preserved
Gate R1 TCP-proxy precondition: MUST BE REPEATED IMMEDIATELY BEFORE MUTATION
Gate R1 local metadata/readiness tooling: REVIEWED; LIVE TOKEN-SCOPED PROOF STILL REQUIRED
Gate R1 execution: NOT YET AUTHORIZED BY THIS DOCUMENT
Gate R2: NOT READY
Gate V: NO-GO
Gate M: NO-GO
Gate D: NO-GO
Production: unchanged and unauthorized
```
