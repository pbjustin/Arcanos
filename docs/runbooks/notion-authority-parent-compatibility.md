# Notion authority parent compatibility rollout

## Overview

The page reader must preserve both valid database and data-source parent
representations. Database-parent metadata is sufficient for a database-root
member only alongside exact membership discovered through that root's advertised
data sources. Capture and verification retain the provider parent and source
membership independently. No schema, API-version, freshness, credential, title,
capacity, readiness, or canon-write policy change accompanies this repair.
The separate title-property reader also requires valid rich-text subtype data
before declaring a title complete; malformed fragments cannot reach activation.

This document prepares a production operation. It does not authorize or execute
deployment, synchronization, migration, backfill, or any Notion modification.

## Prerequisites

- Obtain approval for an exact reviewed release SHA, the production project and
  environment, and both the web and root-worker services. A branch name or local
  checkout is not deployed-commit evidence. If merged, validate the resulting
  release SHA rather than assuming it equals the feature SHA.
- Record current active deployment identities, effective role/start settings,
  immutable revision evidence, health/readiness, and the existing active snapshot
  metadata before rollout. Preserve the coordinated-writer rollout hold and all
  staged configuration. Do not alter provider credentials or API versions.
- Require current CI, focused metadata/synchronization tests, guarded disposable
  PostgreSQL integration, and exact-SHA isolated preview evidence. The established
  preview uses a credential-empty web process and passive worker; its synthetic
  parser proof is separate from real PostgreSQL activation tests.

## Setup

Use the established [Railway lifecycle](../RAILWAY_DEPLOYMENT.md). Before any
preview execution, attest its exact environment identity, empty shared variables,
role-only service variables, and absence of databases, queues, volumes, writable
Notion connections, and source triggers. Never copy production variables or
private content into synthetic fixtures. The current preview does not run the
normal synchronizer or a database; do not call its health or fixture result full
production-path proof.

## Run locally

Use the pinned Node/npm toolchain and the repository wrapper. Core regression:

```text
node scripts/run-jest.mjs --runTestsByPath tests/backstage-notion-context.test.ts tests/backstage-notion-sync.test.ts tests/backstage-notion-snapshot-status.test.ts tests/native-pr-preview-application.test.ts --coverage=false --runInBand
```

The candidate-search and authority HTTP suites run synthetic Notion reads
through the real synchronizer, deterministic embedding doubles, and fenced
PostgreSQL activation. They verify complete-scope continuity, wrong-parent and
source-membership rejection, failed-refresh retention, and recovery to current
authority. The HTTP fixture continues through bearer authentication, the
canonical Booker route, dispatch, retrieval, and response formatting; model
responses are deterministic doubles.

Both require `BACKSTAGE_CANON_STORYLINE_PG18_TEST_DATABASE_URL` pointing to the
guarded disposable loopback PG18 target described by
`tests/integration/postgresTestDatabase.ts`. Set
`ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE=1` to make missing database setup fail
instead of skip, then run:

```text
node scripts/run-jest.mjs --runTestsByPath tests/integration/backstage-notion-rag-candidate-search.pg18.integration.test.ts tests/integration/backstage-notion-authority-http.pg18.integration.test.ts --coverage=false --runInBand
```

These suites also belong to the required `test:postgres-fencing` CI command.
Their success is local HTTP and PostgreSQL evidence, with synthetic upstream
data; it does not establish live Notion access, model quality, or hosted runtime
recovery. Run type checking, lint, build, documentation checks, `sync:check`, and
the staged `guard:commit` before publication.

## Deploy (Railway)

After separate production approval, promote the approved exact SHA worker first
and web second using the established coordinated rollout. Do not upload the web
until the worker is the sole successful active instance, is ready, and the old
worker has drained. Preserve leases, fencing, commands, variables, and the rollout
hold. Stop on ambiguous revision, partial deployment, readiness failure, or
overlapping writers. No migration or backfill is required by this patch.

Observe a naturally scheduled complete synchronization; a manual synchronization
needs its own authorization. Require a correlated completed-cycle activation or
unchanged result, complete discovered/fetched page inventory, bounded chunks and
embeddings, validated manifest, successful drift checks, and atomic head evidence.
Health/readiness must stay independent of crawl completion.

Use the existing read-only authority-status endpoint, with its purpose-bound
control-plane operator and `backstage:notion-sync` scope, or approved bounded SQL
when that endpoint's credentials are unavailable. SQL must use schema
introspection, a read-only transaction, statement/lock timeouts, and metadata-only
projections. Verify configured/durable root consistency, active snapshot
readability and inventory parity, verification time, latest synchronization
outcome, and actual freshness classification. `last_known_good` permits only
the existing continuity policy; official booking still requires
`current_complete`.

Perform one correlated factual `queryContinuity` request through the documented
`POST /gpt/backstage-booker` contract using its existing purpose-bound bearer:

```json
{
  "action": "queryContinuity",
  "executionMode": "sync",
  "payload": {
    "universeId": "<approved-universe>",
    "query": "<approved-read-only-factual-question>",
    "retrievalMode": "relevant"
  }
}
```

Do not add a session, use generation as a probe, queue this action, bypass auth,
or expose returned private content in evidence. Retain only a safe request
correlation, authority/snapshot status, bounded coverage, and outcome. A scoped
`complete_scope` read must follow validated cursors until exhaustive; keep cursor
values private. Consult [the query contract](../BACKSTAGE_BOOKER_CUSTOM_GPT.md)
for exact scope fields. Do not claim recovery until the deployed revision,
successful refresh, validated active state, and correlated read agree.

## Troubleshooting and rollback

If parsing fails, retain the allowlisted rejection code and transport/decoding
classification without bodies, titles, IDs, or uncontrolled provider errors.
If membership, source drift, completeness, embedding, or activation fails, leave
the previous active snapshot intact and investigate the named phase. Do not
raise limits, skip members, clear records, or mark an index verified manually.

Rollback requires an approved prior exact web/worker pair and the established
safe writer ordering. This patch changes no stored format, so no snapshot or
schema deletion is needed. Older code may resume rejecting database-parent
metadata: rollback can restore runtime behavior without restoring fresh authority.
Keep last-known-good labeling and protected-generation denial in that state.

## References

- [Troubleshooting](../TROUBLESHOOTING.md)
- [Authority-status and continuity contracts](../API.md)
- [Official page retrieval](https://developers.notion.com/reference/retrieve-a-page)
- [Official SDK parent response union](https://github.com/makenotion/notion-sdk-js/blob/main/src/api-endpoints/common.ts)
