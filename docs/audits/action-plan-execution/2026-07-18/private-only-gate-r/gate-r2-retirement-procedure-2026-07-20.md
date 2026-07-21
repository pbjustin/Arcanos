# ARCANOS Phase 2E — Gate R2 Cutover and Retirement Procedure Contract

Status: **READY FOR AUTHORIZED LIVE EXECUTION**

This document defines the evidence and ordering required for Gate R2. The
bounded implementation was independently reviewed at source commit
`b299ecc3dbfeabd968b587d07dce7562bbca1b4f` with 234 focused tests passing.
This document does not itself authorize Railway mutation; live execution still
requires current operator authorization, a clean worktree containing that
commit, and separately entered temporary tokens. Raw Railway volume listing or
deletion is not an approved substitute for the fixed tools.

## Fixed target

```text
Project: Arcanos
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment: phase2e-validation-20260717
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13
Private network ID: 464f2194-3825-4ac1-a705-192566561675
```

Retain these active replacements:

| Role | Service name | Service ID | Instance | Deployment | Image | Volume ID | Volume instance |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PostgreSQL R3 | `phase2e-postgres-r3-20260720` | `7346b3f6-bf3d-46e1-9d66-79f10847ef89` | `86dde430-50ac-4d5c-95c3-cb27064eff51` | `b5e45d34-19b8-4253-b230-c3ab0b60b0d7` | `ghcr.io/railwayapp-templates/postgres-ssl:18.4` | `ce93ced0-0c15-48f9-87fc-d9153ffefdc8` | `c7969acf-79fd-4a6b-83d7-1e6cb442a030` |
| Redis R2 | `phase2e-redis-r2-20260718` | `1ac0bd56-50b3-49eb-954c-ea83515ec915` | `0f34bcbb-bfd0-4df5-954a-bb97371bd460` | `9f102e53-ef25-46b5-80e8-0243eb1512d6` | `redis:8.2.1` | `983c4f0a-9180-4621-b65e-dfdd0b79f2bd` | `b96f20a3-a1f1-40ea-ba4b-334ea3e8ba15` |

Retire these obsolete environment service instances and dispose of their old
volumes only through the ordered contract below:

| Order | Role | Service name | Service ID | Instance | Volume ID | Volume instance |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Original compromised PostgreSQL | `Postgres` | `b7789306-8aef-4113-add5-02883a6cc087` | `6dac21a3-ad8a-4b98-ad50-637054c13729` | `35c26093-1e3f-4d34-b699-89c65d2fb92d` | `b8f04086-2e97-4167-a0fd-bcb259541e9f` |
| 2 | Failed PostgreSQL R2 replacement | `phase2e-postgres-r2-20260718` | `a2a57da4-a928-427f-be30-d4a68b59a117` | `e8c42bea-d887-485b-8aaf-ba0f45d439e8` | `2998734d-7530-4f26-b715-cea4780bd437` | `46113532-5609-46da-b7b4-46b8f06930cc` |
| 3 | Original compromised Redis | `Redis` | `434fa5b4-b52c-4caf-aaba-e87c173bf10d` | `8340f02f-dbcb-4c0e-bdde-b3f7c4bf5856` | `d3690500-fcc5-4c06-afa6-cf30e91f608d` | `f222873c-255e-45a2-9a17-840bdba108f6` |

The fixed inactive consumer identities are:

| Role | Service name | Service ID | Required instance |
| --- | --- | --- | --- |
| Web application | `ARCANOS V2` | `c4ade025-3f13-4fca-9309-5d0dd81396fe` | absent |
| Worker | `ARCANOS Worker` | `1765befb-b805-4051-9af9-28634e986886` | absent |
| Migration validator | `phase2e-migration-validator-20260718` | `d8d5181a-2f72-48d7-8413-6f05d113876c` | `7a645cbc-dadf-4072-84c1-6f0843fa30d9` |
| Compatibility validator | `phase2e-compatibility-validator-20260718` | `febdf999-1c96-48df-8e28-c905b8b27082` | `3c385dd2-c786-4149-9319-2a168a920aa9` |

These instance identities are preserved in
`gate-r2-validator-instance-identity-basis-2026-07-20.json` from the
operator-supplied schema-locked runtime projection. Every Gate R2 use must
freshly revalidate them; the preserved observation is not a substitute for a
current projection.

## Required reviewed tools

- `scripts/gate-r2-validator-reference-projector.js`
- `scripts/gate-r2-fixed-link.js`
- `scripts/gate-r2-validator-cutover.js`
- `scripts/gate-r2-service-instance-retirement.js`
- `scripts/gate-r2-retirement-state-projector.js`
- `scripts/gate-r2-volume-disposition.js`
- `scripts/gate-r2-projector-session-20260720.ps1`
- `scripts/gate-r2-retirement-coordinator.js`
- `scripts/gate-r2-retirement-runner.js`
- the existing Gate R1 metadata, TCP-proxy, private-endpoint, and exact
  deployment-status projectors used by the committed combined proof

Every mutation wrapper must bind the fixed project and environment, accept only
an allowlisted target, suppress raw child output, emit fixed non-sensitive
codes, and require a fresh projection before the next mutation. A lost or
ambiguous acknowledgement authorizes one read-only postprojection and no retry.
The runner must bind the exact secure session directory, session PID, live OS
process-start identity, and committed session-script SHA-256 before invoking
the coordinator, and the coordinator must revalidate the same ready contract.

## Ordered Gate R2 ledger

### 1. Fresh combined isolation proof

Immediately before mutation, repeat the complete combined Gate R1 proof with a
new temporary environment-scoped token. Require current metadata, the five
data-service TCP-proxy counts to be exactly zero, two active private endpoints,
and exact successful
deployment verification for PostgreSQL R3 and Redis R2. Stop and acknowledge
the projector session and revoke the token after the proof.

The three obsolete services must remain inactive. Both replacements must retain
their exact identities, distinct volumes, approved images, bounded restart
configuration, zero public domains, zero custom domains, zero TCP proxies, no
`*_PUBLIC_URL` variable names, and `ACTIVE` private endpoints. Applications,
workers, validators, daemons, bridges, and executors must remain inactive.

### 2. Validator reference baseline

Open a second masked projector session with a second, newly created temporary
environment-scoped project token. This Gate R2 session is distinct from the
fresh combined-proof session and permits exactly the following fourteen requests:

1. migration-validator reference baseline;
2. compatibility-validator reference baseline;
3. migration-validator reference projection after its cutover;
4. compatibility-validator reference projection after its cutover;
5. migration-validator reference projection after both cutovers;
6. compatibility-validator reference projection after both cutovers;
7. retirement-state preprojection;
8. retirement postprojection through original PostgreSQL;
9. retirement postprojection through failed PostgreSQL R2;
10. retirement postprojection through original Redis;
11. cumulative final-state projection after original PostgreSQL volume
   disposition or skip;
12. cumulative final-state projection after failed PostgreSQL R2 volume
    disposition or skip;
13. cumulative final-state projection after original Redis volume disposition
    or skip; and
14. stop plus consumed acknowledgement.

Requests 11–13 use the cumulative final retirement state, require the selected
old volume to be absent, and inspect all three old volumes; they do not roll the
retirement expectation backward. Request 13 is also the final target-environment
Gate C projection: it must reprove the replacements, endpoints, deployment
identities, domains, proxies, variable-name contracts, validator references,
and non-deployment inventory before request 14 stops and acknowledges the
session. Revoke this second token immediately after request 14.

Requests 7–13 additionally require service-scoped TCP-proxy counts of zero for
ARCANOS V2, ARCANOS Worker, the migration validator, and the compatibility
validator. A proxy on any inactive consumer blocks the ledger.

The masked token exists only inside the separate projector-session process.
Every mutation wrapper must reject the Gate R2 token if it is present in its
own parent environment, and must execute its one mutation inside the exact
isolated scratch link that it just verified.

Use only `scripts/gate-r2-validator-reference-projector.js`. It may emit:

- the exact fixed validator profile, service, and service-instance identity;
- an active deployment count fixed at zero;
- a variable count of zero or one; and
- one fixed `referenceCategory` without resolving the reference.

It must not emit a resolved URL, credential, variable value, raw Railway
response, public-URL variable name, or arbitrary configuration. An additional
variable key is a schema error rather than a projected count. Require both
validators to be inactive and require no application, worker, or Redis
consumer.

### 3. Validator cutover with deployment suppression

Use only `scripts/gate-r2-validator-cutover.js`, once for each exact validator.
The sole approved target reference is:

```text
${{phase2e-postgres-r3-20260720.DATABASE_URL}}
```

Prohibited reference target:

```text
${{phase2e-postgres-r2-20260718.DATABASE_URL}}
```

The wrapper must preserve deployment suppression. After each cutover, project
state before continuing. After both cutovers, require each validator to have
exactly one `DATABASE_URL` reference to PostgreSQL R3, zero obsolete
PostgreSQL references, zero public-URL variable names, and zero deployments.

If either write or projection is nonzero, malformed, lost, timed out,
ambiguous, or inconsistent, stop with every obsolete service and volume still
retained. Do not retry and do not perform an unreviewed rollback.

### 4. One-at-a-time service-instance retirement

Reprove replacement health and exposure immediately before the first
destructive transition. Then use only
`scripts/gate-r2-service-instance-retirement.js`, in the exact order listed in
the fixed-target table.

After every single retirement attempt, invoke
`scripts/gate-r2-retirement-state-projector.js` and require:

- the exact target environment service instance is absent or deleted;
- its active deployment and reference counts are zero;
- the other not-yet-retired obsolete services remain inactive;
- PostgreSQL R3 and Redis R2 remain unchanged and private-only; and
- the exact ARCANOS V2 and Worker services remain absent from the environment;
- both fixed validator instances remain present but inactive; and
- no non-target service instance was deleted, deployed, or restarted.

Do not begin the next retirement until the postprojection passes. Do not claim
that a project-level service record was deleted when only its environment
service instance was marked deleted.

### 5. Separate volume disposition

Only after all three obsolete service instances are proven retired, use the
retirement-state projector to determine whether each exact old volume is absent
or remains detached.

- Already absent: record the platform disposition and issue no deletion.
- Present exactly once and detached: eligible for the separately reviewed
  fixed volume-disposition wrapper.
- Attached, duplicated, unknown, or ambiguous: preserve it and stop.

The fixed `scripts/gate-r2-volume-disposition.js` wrapper may be invoked only
after the retirement-state projector categorizes the same exact profile as
`RETAINED_DETACHED` and the live authorization names the reviewed source
commit. It must not detach volumes or accept arbitrary IDs. A deletion with an
ambiguous result permits one fresh state projection and no retry.

There is no rollback to the old preview database state. Sanitized committed
migration evidence remains historical; Gate M must validate the migration
again against PostgreSQL R3.

### 6. Full Gate C isolation rerun

The cumulative final projection in request 13 is the target-environment Gate C
rerun. It must pass before request 14 stops and acknowledges the session and
before the Gate R2 token is revoked. Combine that fixed response with approved
sanitized non-impact evidence; do not open another token session merely to
repeat the same target projection. Require:

- all three obsolete environment service instances are absent or deleted;
- all three old volume IDs are absent with an explicit disposition record;
- validators reference only PostgreSQL R3 and remain undeployed;
- PostgreSQL R3 and Redis R2 retain their exact successful deployments,
  distinct volumes, approved images, and `ACTIVE` private endpoints;
- domain, custom-domain, TCP-proxy, and public-URL-variable counts are zero;
- no stale reference names an obsolete service; and
- production and Phase 2D stable identities remain unchanged through approved
  read-only evidence.

## Abort and rollback contract

- Preflight or reference mismatch: perform no mutation.
- Cutover failure: keep validators inactive and retain all obsolete services
  and volumes; do not continue to retirement.
- Partial service retirement: preserve the exact observed state, do not retry,
  and request a new decision. Never recreate or restart a retired generation.
- Attached or ambiguous volume: preserve it and stop; never detach it
  speculatively.
- Ambiguous volume deletion: project once, do not retry.
- Unexpected public exposure, deployment, target mismatch, secret disclosure,
  or production or Phase 2D change: stop immediately.
- Recovery after an irreversible step uses a new service, volume, and credential
  under separate authorization, never a compromised generation.

## Explicitly prohibited

- Deploying or restarting ARCANOS V2, ARCANOS Worker, either validator, a
  daemon, bridge, scheduler, or executor.
- Applying a migration, DDL, application SQL, or a Redis data operation.
- Creating an ActionPlan, execution run, claim, or result.
- Calling OpenAI or another provider.
- Reading or recording credentials, resolved references, connection strings,
  raw variables, raw Railway responses, logs, or application data.
- Creating a domain or TCP proxy.
- Modifying production or Phase 2D.
- Deleting PostgreSQL R3, Redis R2, either replacement volume, or the Phase 2E
  environment.
- Push, pull request, merge, or any mutation outside the exact Gate R2 targets.

## Required sanitized evidence artifact

The future Gate R2 artifact must record:

- reviewed source commit, clean worktree, focused test counts, Railway CLI
  identity, and exact target;
- fresh combined proof observations and token revocation;
- the separate fourteen-request Gate R2 projector ledger and its token
  revocation;
- validator reference baseline, each cutover attempt, every postprojection,
  and confirmation that deployment counts remained zero;
- one record per service retirement with exact target, fixed result code,
  postprojection, and attempt count;
- one record per old volume distinguishing already absent, deleted by the fixed
  wrapper, or retained because disposition was blocked;
- the full Gate C projection and stable replacement identities;
- zero application, worker, validator, daemon, executor, migration, SQL, Redis
  data, ActionPlan, and provider effects;
- production and Phase 2D non-impact evidence;
- credential, connection-string, resolved-reference, raw-variable, raw-log,
  and payload disclosure counts, all zero;
- independent review, limitations, abort state, and the exact rollback boundary.

Gate R2 may be classified `PASS` only when every old service and volume has its
required terminal disposition and the final Gate C rerun passes. A partial
retirement or retained old volume is `BLOCKED`, not success.
