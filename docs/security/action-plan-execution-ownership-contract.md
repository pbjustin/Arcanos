# ARCANOS ActionPlan Execution Ownership and Result-Submission Contract

- Status: Approved for local implementation — Phase 2E Gate A and additive Migration Gate
- Scope: Action-level execution ownership, command/result separation, authenticated claims, result acceptance, idempotency, and durable audit evidence
- Baseline branch: `codex/preview-log-hygiene-first-boot`
- Baseline commit: `410c04a890c021ae51148e58391f8e653be11943`
- Implementation branch: `codex/action-plan-execution-ownership`
- Approval baseline commit: `5e8ef46f48adea6eca82b4fd919821c939cca6c6`
- Contract date: 2026-07-17
- Related contracts: `docs/security/clear-decision-contract.md`, `docs/security/action-plan-lifecycle-contract.md`, `docs/security/credential-verification-contract.md`

## Approval boundary

This document records the approved Phase 2E local implementation decision.

Gate A authorizes the bounded production TypeScript and Python implementation in the local checkout. The additive Migration Gate authorizes creating the reviewed forward and compensating artifacts and applying them only to a dedicated local ephemeral PostgreSQL database. Neither approval authorizes configuring or rotating credentials, changing Railway, creating a preview, applying a migration outside a local ephemeral database, deploying, activating an executor, making external-provider calls, pushing, opening a pull request, merging, touching production, or deleting an environment.

Implementation remains local until a later gate is explicitly approved. No Railway configuration, secret, deployed service, staging/preview database, or production database may be changed under these approvals.

## Confirmed defect

The pre-change behavior is preserved in `docs/audits/action-plan-execution/2026-07-17/pre-change-behavior.json` and the Phase 2E historical characterization suites.

```text
Python daemon
  -> executes one ActionPlan action locally
  -> serializes its real success or failure
  -> POST /plans/:planId/execute

TypeScript HTTP adapter
  -> ignores the submitted body
  -> rechecks lifecycle and CLEAR
  -> writes status=success for every stored action
  -> returns executed
```

The MCP `plans.execute` adapter has the same synthetic-success behavior. Neither TypeScript adapter dispatches work to Python, the Railway worker, or an inline backend executor.

This permits a failed Python action to become backend success, one submitted result to create success for unexecuted siblings, and a daemon command to be acknowledged after durable result submission failed.

## Current topology and trust findings

| Surface or runtime | Confirmed role | Trust finding |
|---|---|---|
| TypeScript web | Public HTTP and MCP adapter, CLEAR/lifecycle gate, current persistence caller | No application authentication on HTTP ActionPlan routes |
| TypeScript worker | General job worker | No ActionPlan execution consumer found |
| Python daemon | Only located real ActionPlan executor; supports `terminal.run` | Sends a bearer credential, but the plan route does not verify it |
| MCP | Authenticated destructive command adapter | No safe external executor identity or result-submission contract |
| Generic daemon queue | In-memory command transport | Context is hardcoded to `anonymous-daemon`; no ActionPlan producer found |
| Postgres | Durable plan and legacy result store | No run, attempt, owner, realm, action digest, or result idempotency identity |
| Redis | Shared cache/runtime support | Not an authoritative ActionPlan execution ledger |

Read-only Railway evidence confirms that production and the Phase 2D preview publicly answer plan-route requests without an authentication challenge. Bounded logs did not prove active result submission. Active private, installed, forked, or binary Python clients remain unknown.

## Gate A decision

Adopt the operator-specified explicit hybrid model with server-selected ownership.

The TypeScript backend is authoritative for:

- command authorization;
- current lifecycle and CLEAR gates;
- execution-command idempotency;
- action selection;
- executor-kind selection;
- execution realm;
- run creation and state;
- claim authorization;
- result acceptance and idempotency;
- plan aggregation; and
- append-only execution evidence.

An external executor may execute only a run assigned to its authenticated server-side principal. It submits evidence for exactly that run. It never chooses the executor kind, realm, plan, action, or lifecycle meaning.

HTTP and MCP command adapters delegate to one focused TypeScript ActionPlan execution domain service. Authentication and protocol envelopes remain adapter-specific; run creation, state transitions, idempotency, and aggregation are not duplicated across adapters.

### Proven executor mapping

| Trusted action evidence | Executor kind | Phase 2E status |
|---|---|---|
| Stored action capability `terminal.run` with an assigned agent matching the configured Python executor identity | `python-daemon` | Supported after the run is claimed |
| Any other capability | None | Fail closed with `ACTION_PLAN_EXECUTOR_UNAVAILABLE` |
| `backend-worker` | None | Not supported; no real ActionPlan worker implementation was found |
| `backend-inline` | None | Not supported; current synthetic success is not an executor |

The caller cannot supply `executorKind`. A future executor mapping requires separate evidence and tests.

## Authentication and authority contract

The current HTTP and daemon authentication surfaces are not reusable as a complete protocol:

- the daemon context is anonymous;
- the GPT Access token has one configuration-wide scope set and is coupled to the GPT gateway;
- only HTTP MCP has a bearer-authenticated transport; stdio and internal MCP contexts have no authenticated principal;
- worker-helper authentication is route-local and accepts an unsuitable OR policy;
- the Python `BackendApiClient` applies one credential provider to every backend request; and
- no current credential identifies one physical Python ActionPlan executor.

The approved local implementation adds purpose-bound credential verification, identity schemas, and fail-closed authorization. Stable principals are independent of token rotation. Credential generation, secret-store configuration, and rotation remain unauthorized until a later explicit gate.

| Role | Server-derived principal | Fixed authority |
|---|---|---|
| ActionPlan requester | Configured requester principal | Create and read realm-owned plans; request execution; read commands, runs, and bounded results it created |
| ActionPlan operator | Configured operator principal | Create/read any realm-owned plan; approve, block, expire, and explicitly request execution; mutate/read agent registration and capability state; read realm-owned execution evidence |
| Python executor instance | Configured per-installation executor principal, instance ID, and agent ID | Discover, claim, start, report, and read only runs preassigned to that principal in the current realm |
| HTTP MCP requester | Configured principal bound to the existing HTTP MCP bearer | Create/read owned plans; request execution and read only command/run/result evidence created by that principal |

Contract variable names, with values never committed or logged:

- `ACTION_PLAN_REQUEST_TOKEN`
- `ACTION_PLAN_REQUEST_PRINCIPAL_ID`
- `ACTION_PLAN_OPERATOR_TOKEN`
- `ACTION_PLAN_OPERATOR_PRINCIPAL_ID`
- `ACTION_PLAN_EXECUTOR_TOKEN`
- `ACTION_PLAN_EXECUTOR_PRINCIPAL_ID`
- `ACTION_PLAN_EXECUTOR_INSTANCE_ID`
- `ACTION_PLAN_EXECUTOR_AGENT_ID`
- `ACTION_PLAN_EXECUTOR_EXPECTED_REALM`
- `ACTION_PLAN_MCP_REQUEST_PRINCIPAL_ID`

The HTTP boundary reuses the Phase 2A opaque-secret equality primitive and the existing strict bounded Bearer extraction style. It does not create new cryptography, accept token material in request bodies, or reuse the anonymous daemon context. Tokens are independently generated with at least 256 bits of entropy and remain within the Phase 2A parser bounds. Protocol activation fails closed when a required credential or identity is absent, empty, malformed, duplicated, or equal to a different role's credential or identity. Stable IDs are bounded, normalized, and never derived from the presented token.

The credential-to-principal, executor-kind, instance, assigned-agent, scope, and realm mapping is server configuration. Payload fields cannot change it. The first implementation supports exactly one configured Python executor instance per realm. Multiple physical daemons or realms must not share the credential or instance ID. Credential rotation may overlap old/new token values only when both map to the same stable principal, instance, role, and realm; revocation does not transfer claimed work.

Python uses a dedicated, narrow ActionPlan execution protocol client with its own executor credential provider. Heartbeat, generic daemon queue, and unrelated backend calls retain their current credential and cannot borrow the executor token.

### Operation authority matrix

| Operation | Requester | Operator | Python executor | HTTP MCP requester | Anonymous / stdio or internal MCP without injected principal |
|---|---:|---:|---:|---:|---:|
| Create/read owned plan | Yes | Yes | No | Yes | No |
| Approve/block/expire plan | No | Yes | No | No | No |
| Register/read/mutate Agent capability | No | Yes | No | No | No |
| Request execution | Yes | Yes | No | Yes | No |
| Discover/claim/start assigned run | No | No | Yes | No | No |
| Submit result | No | No | Yes | No | No |
| Heartbeat legacy Agent record | No | No | No | No | No |
| Read command/run | Creator only | Yes | Owned run only | Creator only | No |
| Read bounded terminal result | Creator only | Yes | Owned run only | Creator only | No |
| Cancel or administrative retry | Unsupported | Unsupported | Unsupported | Unsupported | No |

When the Phase 2E protocol code is deployed, every ActionPlan HTTP read and lifecycle mutation route is authenticated or disabled: plan create/list/get, approve, block, expire, execute, legacy results, and the stored-plan `GET /clear/:planId` score read. The stored CLEAR read uses authoritative storage only, requires the current server-derived realm, conceals requester ownership mismatches as not found, permits the explicit operator override, rejects executor credentials, and is always no-store; the non-persisting `POST /clear/evaluate` evaluator remains a separate boundary. Agent registration, agent reads, and capability mutation are operator-authenticated because executor selection cannot trust anonymously readable or mutable registry data. Legacy HTTP and MCP `agents.heartbeat` are disabled while Phase 2E is active; `Agent.status` and `lastHeartbeat` are non-authoritative for run ownership and availability. The separately authenticated `/api/daemon/heartbeat` transport remains Phase 2A liveness only and cannot discover, claim, start, or report a run. Existing legacy records with unknown requester or realm provenance are operator-readable only and are not executable.

HTTP MCP maps the configured bearer to one fixed requester principal. It may create a realm-owned plan and request execution only for a plan owned by that same principal. The operator may request execution for any realm-owned plan. The confirmation nonce remains a separate operation gate and is not identity, ownership, delegation, or operator authority. Destructive ActionPlan tools are omitted from stdio and internal MCP registries unless a trusted principal is injected into the server context; missing context never falls back to a synthetic principal. Executor claim/start/result tools are not registered on the ordinary MCP server in the initial implementation.

Cancellation and administrative retry are unsupported in the first Phase 2E implementation. They are not inferred from request, claim, result, or read authority. A later endpoint requires separately defined operator authority and confirmation.

### HTTP boundary controls

The command, claim, result, status, and capability routes must reuse the repository's existing security-header and actor-aware rate-limit middleware. Authentication failures are throttled by a trustworthy ingress-derived client key plus a non-reversible credential fingerprint; authenticated requests are throttled by the server-derived principal and operation. Neither an IP address nor a rate-limit key establishes authorization. Railway proxy-address handling must be verified before relying on an address as an abuse-control input.

Every route accepts only the documented content type, path identifiers, headers, and strict schema. Unknown keys are rejected. Authentication and authorization occur before database mutation or result processing, and all database access uses Prisma or parameterized SQL. Public errors use the stable categories below and never return parser internals, credential material, SQL, paths, stacks, or submitted payloads.

Capability, claim, start, result, status, and bounded-result responses set `Cache-Control: no-store`. Bounded run output/error is classified as sensitive execution evidence and is never copied into ordinary logs, metrics, events, traces, or snapshots. Phase 2E introduces no automatic deletion policy; preview uses synthetic non-sensitive output only, and a production retention/deletion decision requires separate approval before production activation.

The baseline application installs `express.json({ limit: config.limits.jsonLimit })` globally, and the configured default is 10 MB. The approved implementation must establish and test a route-specific 64 KiB pre-parse limit without raising any other route's limit. A `Content-Length` check alone is insufficient because chunked bodies can omit it. The implementation may use only the approved bounded ActionPlan parser seam; any broad global parser change requires renewed operator approval.

## Plan provenance and server-derived execution realm

On Railway, the realm is derived from trusted Railway project and environment identifiers:

```text
railway:<RAILWAY_PROJECT_ID>:<RAILWAY_ENVIRONMENT_ID>
```

The final canonical realm is limited to the shared 256-character protocol bound. The service fails closed with `ACTION_PLAN_REALM_UNAVAILABLE` when a deployed process cannot derive a realm within that bound. Tests inject `local-test` through an internal dependency seam. The fixed `local-development` realm is available only through an explicit development configuration and is rejected when Railway deployment markers are present.

New plans store the server-derived realm, authenticated creator principal, protocol version, and an execution generation. Existing plans remain null/legacy and cannot create Phase 2E runs. No automatic adoption or destructive backfill is permitted; a later operator-approved reconciliation phase may adopt a legacy plan only after its prior execution evidence is resolved.

The body, query string, headers, host, client address, MCP arguments, and Python client cannot select or override the realm. Command, discovery, claim, start, result, status, and result-read repositories predicate the source plan and all run rows on the current server-derived realm. A cross-realm request performs zero mutation. Actions inherit realm provenance only through their realm-bound plan and enforced plan/action foreign keys.

The Python executor pins the non-secret expected realm through operator-controlled local configuration before contacting the backend. Authenticated capability and claim responses return the canonical server-derived realm; Python requires an exact match and never adopts a first-seen realm from a response. Missing local pin or mismatch is `ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE`, with no claim, execution, or acknowledgement. The expected-realm field is validation only and never selects backend data.

## Protocol operations

### Execution command

```text
POST /plans/:planId/execute
```

Operation ID: `requestActionPlanExecution`.

The operation:

1. authenticates a requester;
2. requires a bounded `Idempotency-Key` header;
3. accepts only an absent body or strict empty JSON object in the initial implementation;
4. locks the authoritative realm-owned plan and its ordered actions;
5. verifies requester provenance, execution generation, expiry, Phase 2D lifecycle, current Phase 2B CLEAR evidence, and confirmation;
6. rejects any unresolved legacy `ExecutionResult` or active/new-protocol attempt for the plan actions;
7. directly reads the authoritative database agent row, verifies the configured agent exists and grants the exact capability, and derives one supported executor kind and preassigned executor principal for every action without cache fallback;
8. creates one immutable bounded execution snapshot per action;
9. atomically creates the command, one `REQUESTED` run and requested event per action, and the immutable command run set; and
10. returns the command ID, run IDs, states, and authorized status locations.

The command does not execute an action, enqueue a worker, invoke Python, invoke an execution callback, write a terminal result, or mark the plan complete.

A requester may command only a plan whose stored owner principal and realm match that requester and the current realm. The operator may command any current realm-owned plan as an explicit `operator_override` actor category; the override is recorded in safe command/event metadata and does not change plan ownership. HTTP MCP has requester authority only and cannot invoke the operator override.

All actions are selected in the first implementation. Partial action selection is deferred because no authoritative caller or aggregation contract currently requires it.

The initial `python-daemon` mapping is deliberately narrow. Every selected action must use the exact `terminal.run` capability, target the configured authoritative Python agent, and contain a `params.command` string that is nonblank and no longer than 16,384 Unicode code points. Missing, null, non-string, blank, or oversized commands fail with `ACTION_PLAN_EXECUTOR_UNAVAILABLE` before any command, run, or event is written. Action identifiers use the shared protocol grammar `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; an omitted identifier may be generated by the backend, but a caller-supplied identifier outside that grammar is rejected at the creation boundary.

A body containing result fields returns `409 ACTION_PLAN_RESULT_ENDPOINT_REQUIRED`. Other non-empty or unknown bodies return `400 ACTION_PLAN_EXECUTION_REQUEST_INVALID`. Neither response dispatches work or creates a run.

The policy recheck follows the Phase 2B contract. An explicit coherent block may preserve the existing evaluator-issued block behavior, but no run is created. Indeterminate, invalid, or failed evaluation returns its stable failure and never fabricates a block.

The successful command stores the current authoritative recheck category, evaluation timestamp, and a versioned content-addressed commitment of `{ planId, evaluated plan generation, decision, overall }`. The commitment distinguishes an explicit `null` score from every numeric score without making the score independently readable or placing it in logs. The repository requires the generation evaluated by the HTTP or MCP adapter to equal the locked durable plan generation before creating any run. `ClearScore` remains historical lifecycle context and is not command, replay, claim, or start authority.

Claim and start do not call an external policy dependency while holding database locks. They verify command-wide immutable policy-evidence cohesion, plan generation/expiry, lifecycle status, exact action snapshots, executor binding, and authoritative capabilities. A later recheck or policy mutation must increment plan execution generation and supersede unstarted work. The repository has no separate CLEAR evidence TTL, so Phase 2E does not invent one; plan `expiresAt`, explicit recheck, and generation changes are the available freshness authorities.

### Executor discovery and claim

The executor obtains work through a dedicated authenticated operation; the anonymous generic daemon queue is not used:

```text
POST /action-plan-executions/claim-next
```

Operation ID: `claimNextActionPlanExecution`.

The body is an absent body or strict empty object and the operation requires a bounded claim `Idempotency-Key`. The server derives realm, executor principal, physical instance, assigned agent, and executor kind. In one Postgres transaction it:

1. finds the oldest `REQUESTED` run preassigned to that principal and instance with `FOR UPDATE SKIP LOCKED`;
2. locks the run, command, plan, and action;
3. verifies plan realm/provenance, execution generation, expiry, lifecycle, confirmation, current stored coherent CLEAR evidence, executor mapping, current database capability grant, agent assignment, and immutable snapshot equality;
4. permits `approved`, or `in_progress` only for a sibling run in the same immutable command run set;
5. conditionally changes exactly that run from `REQUESTED` to `CLAIMED`; and
6. appends one `execution_claimed` event and returns the immutable assignment.

If the selected run is stale, blocked, expired, terminal, or otherwise incompatible, it is not returned as executable work. The operation records a bounded safe rejection/supersession decision according to the state contract and continues only within a bounded scan limit. It never silently reassigns work.

When no eligible work remains after the bounded scan, claim-next returns `204 No Content`, performs no event or run mutation, and does not consume or store the poll idempotency key. Python discards that key, applies bounded backoff, and creates a fresh key for the next poll. A no-work key is therefore never later bound to a run. Authentication, persistence, or scan failure returns a stable non-204 error and is not treated as no work.

Exact-run recovery uses:

```text
POST /plans/:planId/executions/:runId/claim
```

Operation ID: `claimActionPlanExecution`.

The exact operation applies the same predicates. A retry with the same claim key while still `CLAIMED` returns the same assignment with disposition `CLAIM_REPLAY_NOT_STARTED`. A `RUNNING` or terminal replay returns a non-executable recovery disposition and no action parameters. A wrong principal or instance is rejected. This prevents a replayed claim response from repeating a local side effect.

The assignment contains only the data bound to the run: canonical execution realm, plan ID, run ID, action ID, opaque snapshot ID and version, capability, unexpanded execution snapshot, timeout, command ID, plan execution generation, and current policy/lifecycle facts. Ordinary status responses never expose the execution snapshot.

No lease expiry or automatic reassignment is introduced. A process loss after claim leaves the run `CLAIMED` or `RUNNING` for same-instance recovery or operator resolution; it does not transfer ownership.

### Start

```text
POST /plans/:planId/executions/:runId/start
```

Operation ID: `startActionPlanExecution`.

Before any local side effect, the owning executor persists its start intent and calls this operation with a bounded start idempotency key. The transaction re-locks run, command, plan, action, and authoritative database agent row; repeats the claim-time lifecycle, policy, realm, generation, executor, capability-grant, and snapshot checks; conditionally changes `CLAIMED` to `RUNNING`; appends `execution_started`; and changes the plan from `approved` to `in_progress` only through a compare-and-swap. A sibling start may proceed only for the same command while the plan remains compatible.

A same-key retry returns the original `RUNNING` disposition without a second event. If the start response is lost, the daemon may confirm `RUNNING` through the same key or authorized status before executing because its durable local journal proves the local side effect has not begun. Once the journal records local execution started, process recovery never re-executes automatically.

### Result submission

```text
POST /plans/:planId/executions/:runId/result
```

Operation ID: `submitActionPlanExecutionResult`.

The operation requires the authenticated run owner, current realm, an existing `RUNNING` run, and a bounded `Idempotency-Key` header. It validates a strict body:

```json
{
  "action_id": "server-assigned-action-id",
  "snapshot_id": "server-assigned-opaque-snapshot-id",
  "outcome": "succeeded | failed",
  "output": "optional bounded JSON",
  "error": {
    "code": "optional stable bounded code",
    "category": "optional stable bounded category"
  }
}
```

The body may assert action identity and snapshot ID, but those values never establish authority. They must match the stored run. Unknown fields, owner fields, executor fields, realm fields, lifecycle fields, CLEAR fields, raw credentials, and unbounded diagnostic fields are rejected.

Initial limits:

- maximum HTTP body: 64 KiB;
- maximum encoded `output`: 32 KiB;
- maximum encoded `error`: 4 KiB;
- maximum error code/category: 64 characters each;
- finite JSON numbers only;
- maximum nesting depth: 8; and
- no circular, binary, function, or non-JSON values.

The result transaction locks the immutable command run set, plan, and current action in the deterministic order defined below. It verifies owner, instance, realm, plan/action membership, stored snapshot identity, and result idempotency; conditionally changes only the bound run from `RUNNING` to `SUCCEEDED` or `FAILED`; records the first result-key hash, result fingerprint, and opaque acceptance receipt; and appends one terminal event. A result whose submitted snapshot ID differs from the run is rejected. A current plan/action change after the run reached `RUNNING` does not erase authentic evidence about the immutable run snapshot: the run result is accepted, but aggregation is suppressed as stale and requires operator recovery.

It then aggregates only the immutable run set belonging to that command. Plan completion is a compare-and-swap from the expected `in_progress` generation. A concurrently blocked, expired, failed, completed, or otherwise incompatible plan remains unchanged; the authentic run result remains durable evidence and a bounded aggregation-deferred event is recorded. The operation never initiates execution, creates a run, touches a sibling run's terminal fields, or re-evaluates owner selection.

### Run status

```text
GET /plans/:planId/executions/:runId
```

Operation ID: `getActionPlanExecution`.

The authenticated requester that created the command, the operator, or the assigned/owning executor may read a sanitized status. It includes stable IDs, state, terminal category, timestamps, replay disposition, result reference, and the key-bound opaque acceptance receipt needed for evidence-based recovery. It excludes action parameters, commands, credentials, fingerprints, full output/error, traces, SQL, paths, headers, and provider payloads.

### Bounded result read

```text
GET /plans/:planId/executions/:runId/result
```

Operation ID: `getActionPlanExecutionResult`.

The command creator, operator, or owning executor may retrieve the accepted bounded terminal result. Responses use `Cache-Control: no-store`. Existing HTTP `GET /plans/:planId/results` and embedded legacy `executionResults` remain operator-only historical evidence; MCP `plans.results` is omitted. When a plan has Phase 2E runs, the HTTP legacy surface returns `ACTION_PLAN_LEGACY_RESULT_VIEW_UNAVAILABLE` with the authoritative status location instead of empty or stale evidence.

### Protocol capability

```text
GET /action-plan-executions/protocol
```

The authenticated capability response identifies the canonical server-derived execution realm, dedicated-result protocol version, caller role, permitted operations, schema versions, and locations. Requester, operator, and executor credentials may call it and receive only their own capabilities. A Phase 2E Python client first compares this realm to its operator-configured expected realm, then requires the executor capability before polling. Missing, legacy, malformed, or mismatched capability is incompatible and never enables result-through-`/execute` fallback. This unambiguous path does not collide with `/plans/:planId`.

### MCP operations

| Existing/new MCP tool | Initial Phase 2E disposition on authenticated HTTP MCP |
|---|---|
| `plans.create` | Creates a realm/requester-owned Phase 2E plan |
| `plans.list` / `plans.get` | Returns only plans owned by that requester |
| `plans.approve` / `plans.block` / `plans.expire` | Omitted; requester confirmation is not operator authority |
| `plans.execute` | Command only for an owned plan; requires explicit idempotency key and confirmation nonce |
| `plans.results` | Omitted; legacy records lack requester provenance and remain operator-readable through authenticated HTTP only |
| `plans.get_execution` | Sanitized creator-authorized run read |
| `plans.get_execution_result` | Bounded creator-authorized terminal-result read |
| `agents.register` | Omitted; operator-only registry mutation is not available to requester MCP |
| `agents.list` / `agents.get` | Omitted until agent records have a separately approved realm/read policy |
| `agents.heartbeat` | Omitted; requester MCP is not an agent or operator principal |

Claim, start, and result-submission tools are not registered on the ordinary MCP server in the initial implementation. Stdio and internal MCP registries omit ActionPlan create/read/command tools unless an explicit trusted requester principal is injected into context.

The one configured HTTP MCP bearer represents one shared service/audit principal, not an individual human or client identity. It cannot establish per-user attribution or delegation; that limitation is explicit in command evidence.

The MCP confirmation nonce is not part of the command fingerprint; the required command idempotency key is. No MCP operation chooses semantics from payload shape.

### Schema and OpenAPI source

The implementation is schema-first:

- `packages/protocol/schemas/v1/action-plan/execution-command.schema.json`;
- `packages/protocol/schemas/v1/action-plan/execution-claim.schema.json`;
- `packages/protocol/schemas/v1/action-plan/execution-start.schema.json`;
- `packages/protocol/schemas/v1/action-plan/execution-result.schema.json`;
- `packages/protocol/schemas/v1/action-plan/execution-result-read.schema.json`;
- `packages/protocol/schemas/v1/action-plan/execution-status.schema.json`;
- `packages/protocol/schemas/v1/action-plan/execution-capability.schema.json`;
- `contracts/action_plan_execution.openapi.v1.json` is the canonical public HTTP description and uses unique operation IDs;
- the introspection router serves the normalized contract through the repository's existing contract pattern; and
- `tests/fixtures/action-plan-execution-protocol-v1.json` is consumed by TypeScript and Python tests.

The command schema is strict and excludes result fields. The result schema replaces the currently unused boundary import and is actively applied only at the dedicated result endpoint; it excludes command, owner, executor-kind, realm, lifecycle, and CLEAR fields. OpenAPI defines requester/executor security schemes, exact HTTP statuses, every stable error category, unique operation IDs, content types, and body limits. Shared fixtures define all request, response, replay, and error nouns. A normalized before/after contract diff is required before preview deployment.

## Immutable action snapshot contract

Repository evidence shows that `terminal.run` currently stores an arbitrary command string inside arbitrary JSON parameters. A public SHA-256 digest over that material would not prove secret exclusion and could become an oracle for low-entropy sensitive values. Phase 2E therefore chooses the canonical model's immutable-action-snapshot option and does not expose or require a cross-language action digest.

Snapshot version: `action-execution-snapshot-v1`.

At command creation, the backend builds one bounded immutable snapshot from the locked stored action and records a server-generated opaque snapshot ID. The snapshot contains:

- snapshot schema version;
- plan ID and action ID;
- assigned agent ID;
- capability;
- stored, unexpanded execution parameters;
- timeout;
- rollback action definition;
- sort order;
- server-selected executor kind and assigned executor principal; and
- backend-only fingerprint of the authoritative agent ID and sorted capability grant; and
- plan execution generation.

The canonical encoded snapshot is limited to 32 KiB, nesting depth 8, finite JSON numbers, and the versioned supported ActionPlan action schema. Oversized or malformed actions are not truncated; run creation fails closed.

The public ActionPlan creation and Phase 2E mutation boundaries use the route-scoped 64 KiB pre-parse seam described above. Creation additionally limits the number of actions, identifier lengths, nested JSON size/depth, and prototype-sensitive keys. These checks are local to the bounded ActionPlan routes and do not alter the application's global JSON parser contract.

It excludes mutable run state, credentials, environment-variable values, resolved secret values, provider responses, and result data. The snapshot builder never reads environment variables or resolves secret references. Stable non-secret references may remain references. Exact configured credential sentinels are rejected, but the implementation does not claim that heuristic scanning can identify every secret embedded in arbitrary legacy text.

Only realm-owned Phase 2E plans created under the authenticated input contract are eligible. Legacy actions with unknown provenance, non-JSON values, unsupported nesting/size, or evidence that secret expansion already occurred fail with `ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE`. The snapshot is never written to logs or execution-event metadata and is returned only through an owner-authenticated claim or same-key recovery response while the run remains `CLAIMED`.

Claim and start compare the locked current action, plan generation, and direct-database capability grant with the stored immutable snapshot before returning or authorizing executable work. Capability revocation or reassignment supersedes the affected unstarted command run set; it never relies on the agent-registry cache. Result acceptance binds to the stored snapshot ID; current-action comparison is an aggregation guard, not a reason to discard authentic evidence for work already started. Python treats the snapshot ID as opaque, executes exactly the returned snapshot, and echoes only the ID; it does not recompute a digest. A changed plan/action before start cannot execute. A change detected after a local side effect preserves the run outcome but prevents aggregation and requires operator recovery; it never fabricates success for the current plan.

## Execution-run state machine

Recognized states:

```text
REQUESTED
CLAIMED
RUNNING
SUCCEEDED
FAILED
CANCELLED
EXPIRED
SUPERSEDED
```

Allowed transitions in the initial implementation:

| From | Operation | To | Notes |
|---|---|---|---|
| `REQUESTED` | authorized claim | `CLAIMED` | Atomic owner binding |
| `CLAIMED` | authorized start | `RUNNING` | Separate pre-side-effect CAS |
| `RUNNING` | accepted success | `SUCCEEDED` | Terminal and immutable |
| `RUNNING` | accepted failure | `FAILED` | Terminal and immutable |
| `REQUESTED` or `CLAIMED` | stale/incompatible evidence | `SUPERSEDED` | Safe server transition; never reassigned |

The schema reserves `CANCELLED` and `EXPIRED`, but the first implementation exposes no public transition endpoint for them. Tests and repository invariants still require those terminal states to reject claims, starts, and results. `SUPERSEDED` is used only when locked pre-execution evidence is stale or incompatible. No state is inferred from a timeout alone.

Because one command represents one immutable multi-action authorization, a pre-start generation, policy, capability, or snapshot conflict supersedes that run and every still-`REQUESTED` or `CLAIMED` sibling in the same command transactionally. Already-`RUNNING` siblings are not cancelled or rewritten; their authentic results may terminalize their own runs but cannot aggregate into a changed plan. If no sibling ever started, the plan remains `approved` and the command is observable as `RECOVERY_REQUIRED`. If any sibling started, the compatible plan remains `in_progress` until all running siblings terminalize, then command-scoped aggregation may move it to `failed`; a concurrent blocked/terminal state still wins.

Terminal state is monotonic. A terminal result cannot be overwritten. Retry is not exposed in the first implementation; a future authorized retry must create a new run with a new attempt number.

## Plan aggregation

- Command creation leaves an approved plan `approved`.
- The first successful start transition changes `approved` to `in_progress` in the same transaction.
- A terminal result updates only its bound run.
- “Required runs” means exactly the immutable action run set created by the result's command, not every historical or future run for the plan.
- While any required run remains non-terminal, a compatible plan remains `in_progress`.
- When every required run is terminal, the plan may compare-and-swap from the expected `in_progress` generation to `completed` only if every run succeeded.
- When every required run is terminal and at least one is `FAILED`, `CANCELLED`, `EXPIRED`, or `SUPERSEDED`, the plan may compare-and-swap from the expected `in_progress` generation to `failed`.
- A concurrent `blocked`, `expired`, `completed`, `failed`, or incompatible generation always wins. The run result is retained, but aggregation records a bounded deferred reason and never revives or overwrites the plan.
- A result never writes a sibling result or fabricates sibling completion.
- A blocked, expired, completed, failed, unknown, or otherwise incompatible plan cannot create new runs.

No automatic retry, cancellation, or partial-success public lifecycle is introduced. Run-level state remains the authoritative evidence when plan status cannot express intermediate detail.

If every run is superseded before any run starts, the plan remains `approved`, the command is non-executable, and attempt-one uniqueness prevents an implicit retry. Operator-authorized reconciliation is required; a new attempt is not inferred.

Every Phase 2E authorization or mutation reads locked database rows directly. Cache-first plan reads, cached status writes, and `ExecutionResult` cache fallback are prohibited. Cache invalidation or update occurs only after commit and is never evidence of durability.

## Idempotency and replay

### Command

The HTTP `Idempotency-Key` is bounded to 256 characters and hashed with a domain-separated SHA-256 label before storage. Raw keys are never stored or logged. The server computes a canonical request fingerprint over protocol version, operation, realm, authenticated requester, plan, plan execution generation, ordered action IDs, snapshot versions, and executor selections. It does not serialize action parameters or secret-bearing values into the command fingerprint.

The unique scope is:

```text
realm + requester principal + plan + operation + idempotency-key hash
```

- Same key and fingerprint returns the original command and run set.
- Same key with a different fingerprint returns `ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT` and zero effects.
- Concurrent same-key requests create one command and at most one run per action through a database uniqueness constraint plus one transaction.
- A global partial uniqueness invariant permits at most one `REQUESTED`, `CLAIMED`, or `RUNNING` run for each plan/action, regardless of requester, key, transport, or realm. A different-key or cross-principal duplicate returns `ACTION_PLAN_EXECUTION_ACTIVE` with zero effects.
- The first implementation permits only attempt one. A later retry requires an explicit operator-authorized contract and a new run ID/attempt.

The HTTP and MCP adapters attempt same-key replay after authenticating and loading the visible authoritative plan, but before lifecycle/terminal rejection, policy recheck, or confirmation-nonce consumption. This ordering lets a client recover a committed response after the plan legitimately advances to `in_progress`, `completed`, or `failed`. Replay is read/verification only: the repository requires the existing command, the same generation, coherent immutable policy evidence across every sibling run, the same ordered actions, executor binding, authoritative capability grant, the stored command fingerprint, and exact immutable snapshots. It does not consult historical `ClearScore`, create a command, or bypass ownership or realm checks. A different key continues through the normal lifecycle gate and cannot use this recovery path.

Action parameters are intentionally excluded from the command fingerprint so that secret-bearing material is not hashed into a reusable oracle. They are not ignored: replay rebuilds and compares the exact bounded immutable snapshot stored for every run. A changed action, capability, order, generation, executor binding, or policy evidence therefore conflicts without placing raw parameters in the idempotency fingerprint.

### Claim and start

Claim and start keys are bounded and hashed under separate operation scopes. Claim-next first looks up the unique scope `(realm, assignedExecutorPrincipalId, assignedExecutorInstanceId, claimKeyHash)` before selecting work. If absent, selection and key binding occur in the same transaction; the unique constraint resolves concurrent same-key requests before either can bind a second run. Claim-next and exact-claim share that scope, so one key cannot identify two runs through different paths. Same key/same selection replays the original `CLAIMED` assignment only while execution has not started. Once that run is `RUNNING` or terminal, the same claim-next key returns its non-executable recovery status and never selects another run. Same key/different selection conflicts. Start uses `(runId, ownerPrincipalId, ownerInstanceId, startKeyHash)` and replays state only, never a second executable assignment.

### Result

The result key is bounded and hashed. The backend-only `result-fingerprint-v1` covers protocol version, run ID, action ID, opaque snapshot ID, terminal outcome, and validated bounded result fields using recursively sorted object keys, preserved array order, explicit null/omission behavior, Unicode JSON strings, and finite parsed JSON numbers. Shared fixtures prove semantic request parity, but Python does not make authorization decisions from a locally recomputed fingerprint. The fingerprint is never placed in public logs or unauthenticated output.

- Same run, same key, same fingerprint returns the accepted response.
- Same run, same key, different fingerprint conflicts.
- Same run, different key, same accepted fingerprint returns the existing accepted response without mutation.
- Same run, any key, conflicting terminal fingerprint conflicts.
- Concurrent results finalize through a `RUNNING` compare-and-swap; one terminal transition wins.
- A lost response is recovered by retrying the same stored key and exact stored validated body, or by confirming the key-bound opaque acceptance receipt through authenticated run status.

The protocol guarantees idempotent protected effects under at-least-once delivery. It does not claim exactly-once network delivery.

Conflicting-result audit evidence is bounded to one event per run and stable rejection category; repeated attempts increment a redacted metric rather than growing an unbounded event stream.

## Stable error contract

HTTP and MCP retain protocol-specific envelopes while using the same semantic categories:

| Category | HTTP | Meaning | Mutation |
|---|---:|---|---|
| `ACTION_PLAN_EXECUTION_AUTH_REQUIRED` | 401 | Missing or invalid purpose-bound authentication | None |
| `ACTION_PLAN_EXECUTION_FORBIDDEN` | 403 | Authenticated principal lacks the operation or run authority | None |
| `ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED` | 503 | Protocol or required schema is not safely activated | None |
| `ACTION_PLAN_RESULT_ENDPOINT_REQUIRED` | 409 | A result-shaped payload was sent to command-only `/execute` | None |
| `ACTION_PLAN_EXECUTION_REQUEST_INVALID` | 400 | Command payload or idempotency input is malformed | None |
| `ACTION_PLAN_EXECUTOR_UNAVAILABLE` | 409 | No proven executor mapping exists for an action | None |
| `ACTION_PLAN_REALM_UNAVAILABLE` | 503 | The server cannot derive a trusted execution realm | None |
| `ACTION_PLAN_PROVENANCE_UNAVAILABLE` | 409 | The source plan lacks current realm/requester provenance | None |
| `ACTION_PLAN_LEGACY_EXECUTION_STATE_UNRESOLVED` | 409 | Legacy result evidence prevents safe new execution | None |
| `ACTION_PLAN_LEGACY_RESULT_VIEW_UNAVAILABLE` | 409 | A legacy read would misstate authoritative Phase 2E evidence | None |
| `ACTION_PLAN_EXECUTION_ACTIVE` | 409 | Another authoritative active attempt already exists | None |
| `ACTION_PLAN_EXECUTION_IDEMPOTENCY_CONFLICT` | 409 | A command key was reused for a different canonical request | None |
| `ACTION_PLAN_EXECUTION_NOT_FOUND` | 404 | No visible run matches plan, run, realm, and caller authority | None |
| `ACTION_PLAN_EXECUTION_CLAIM_CONFLICT` | 409 | A different principal or instance already owns the run | None |
| `ACTION_PLAN_EXECUTION_STATE_CONFLICT` | 409 | The current run state does not permit the operation | None |
| `ACTION_PLAN_EXECUTION_GENERATION_CONFLICT` | 409 | Current plan/action evidence differs from the command generation | Safe supersession before start; otherwise none |
| `ACTION_PLAN_ACTION_SNAPSHOT_UNAVAILABLE` | 422 | A bounded immutable execution snapshot cannot be formed safely | None |
| `ACTION_PLAN_ACTION_SNAPSHOT_CONFLICT` | 409 | Current action evidence differs from the authorized snapshot | Safe supersession before start; otherwise none |
| `ACTION_PLAN_RESULT_IDEMPOTENCY_CONFLICT` | 409 | A result replay conflicts with accepted evidence | One bounded rejection event only when authenticated owner is known |
| `ACTION_PLAN_EXECUTION_PERSISTENCE_FAILED` | 503 | A required atomic write failed | Transaction rollback |
| `ACTION_PLAN_EXECUTION_PROTOCOL_INCOMPATIBLE` | 409 | Client/backend capability versions are incompatible | None |

Public messages are fixed and non-sensitive. Wrong-plan, wrong-run, wrong-owner, and wrong-realm lookups must not reveal which predicate failed. Logs and events contain only stable codes, bounded IDs, actor category, realm identifier, request/trace identifiers, and allowlisted metadata. They never contain raw action parameters, commands, result payloads, credentials, headers, SQL, paths, stacks, or provider responses.

## Approved additive persistence contract — local artifacts only

Existing schema evidence:

- `ActionPlan` has no version or execution realm.
- `Action` has a globally unique ID but no composite `(planId, id)` constraint.
- `ExecutionResult` is unique only by `(planId, actionId)` and has no attempt, owner, realm, digest, or idempotency fields.
- The current result store can report cache fallback as success and is unsuitable for authoritative runs.
- The repository has no working versioned migration runner: documented `db:init` and `db:patch` targets are absent.
- Both web and worker call the sequential runtime `initializeTables()` path, and web startup can continue after schema initialization failure. Phase 2E DDL cannot safely be added to that bootstrap path.

Approved nullable columns on `ActionPlan`:

- execution realm;
- authenticated owner/requester principal ID;
- execution protocol version; and
- monotonic execution generation.

New Phase 2E plan creation writes all four fields. Action, CLEAR, confirmation, executor-assignment, and operator lifecycle changes increment the generation in the same durable transaction. The protocol-owned `approved -> in_progress` start transition and terminal aggregation use status/generation compare-and-swap without incrementing the generation, so unstarted siblings in the same immutable command run set remain valid. A sibling claim/start while `in_progress` also verifies that a started run belongs to the same command. Existing rows remain null/legacy and are not executable or automatically backfilled.

A database CHECK requires the four provenance fields to be either all null for legacy rows or all non-null with execution generation at least one. New protocol repositories accept only the all-non-null form.

Approved additive tables:

### `ActionPlanExecutionSchemaMigration`

- fixed migration version;
- reviewed checksum;
- completed phase;
- validity state; and
- applied timestamp.

This narrow ledger is written only by the out-of-band migrator and read by startup verification. It is not a general runtime migration framework.

### `ActionPlanExecutionCommand`

- command ID;
- plan ID foreign key;
- execution realm;
- requester principal ID;
- idempotency-key hash;
- canonical request fingerprint;
- locked plan execution generation;
- protocol version; and
- creation timestamp.

Unique constraint: realm, requester principal, plan, and idempotency-key hash.

The table represents only `requestActionPlanExecution`; the operation discriminator is fixed by table/protocol version and remains in the request fingerprint rather than a redundant mutable column.

### `ActionPlanExecutionRun`

- run ID;
- command ID foreign key;
- plan ID and action ID;
- attempt number;
- state;
- executor kind;
- assigned agent ID;
- assigned executor principal ID and instance ID;
- claimed executor principal ID;
- claimed executor instance ID;
- execution realm;
- opaque snapshot ID, snapshot schema version, and bounded immutable execution snapshot;
- claim, start, and result idempotency-key hashes/fingerprints as applicable;
- policy evidence category, versioned content-addressed recheck commitment, and evaluated timestamp;
- opaque acceptance receipt;
- terminal category;
- bounded result output and error;
- event sequence/version counter; and
- requested, claimed, started, completed, cancelled, expired, and superseded timestamps.

Unique constraints: command/action, plan/action/attempt, snapshot ID, claim `(realm, assignedExecutorPrincipalId, assignedExecutorInstanceId, claimKeyHash)`, start `(runId, claimedExecutorPrincipalId, claimedExecutorInstanceId, startKeyHash)`, and the documented run/result idempotency identities.

A global partial unique index on plan and action while state is `REQUESTED`, `CLAIMED`, or `RUNNING` prevents different realms, principals, transports, or command keys from creating competing active attempts. Attempt allocation occurs under the same transaction and plan/action lock; the first implementation permits only attempt one because retry is not exposed.

Claim-next uses a partial discovery index on `(executionRealm, assignedExecutorPrincipalId, assignedExecutorInstanceId, state, requestedAt, id)` for `state = 'REQUESTED'`; preview query-plan evidence must show the bounded oldest-work scan uses it.

### `ActionPlanExecutionEvent`

- event ID;
- run ID foreign key;
- run-local sequence;
- event type;
- actor category;
- source service;
- execution realm;
- stable reason code;
- request and trace IDs;
- bounded allowlisted safe metadata; and
- creation timestamp.

Unique constraint: run ID and event sequence.

Required relational constraints:

- command `(planId, realm)` references realm-bound `ActionPlan` with `ON DELETE RESTRICT`;
- run `(commandId, planId, realm)` references its command with `ON DELETE RESTRICT`;
- run `(planId, actionId)` references `Action(planId, id)` with `ON DELETE RESTRICT`;
- event `(runId, realm)` references its run with `ON DELETE RESTRICT`;
- attempt is at least one;
- state, executor kind, snapshot version, and protocol version are checked values; and
- terminal state, terminal category, result fields, and timestamps satisfy coherence checks.

The proposal adds composite unique indexes on `ActionPlan(id, executionRealm)`, `Action(planId, id)`, command `(id, planId, realm)`, and run `(id, realm)` to support those foreign keys. Only the ActionPlan and Action indexes scan existing tables. Duplicate realm/plan columns are constrained through composite foreign keys rather than trusted independently.

The legacy `ExecutionResult` table is not dropped, rewritten, or backfilled. Existing rows remain legacy evidence with unknown run ownership. Command creation fails closed with `ACTION_PLAN_LEGACY_EXECUTION_STATE_UNRESOLVED` when any such row exists for the plan. New Phase 2E outcomes are authoritative in the run table and are not projected into legacy rows.

### Atomic operations

Each operation uses a Postgres transaction and row-level conditional update:

- create command + runs + requested events;
- claim-next/exact claim + owner/instance binding + claimed event;
- start + started event + first compatible plan `in_progress` transition;
- accept terminal result + terminal event + plan aggregation; and
- append at most one authenticated-owner rejection event per run/reason when safe.

Command creation locks the plan and ordered Action rows, checks legacy/new-run conflicts, builds the immutable snapshots, allocates attempt one, and inserts the command, runs, and events in one transaction. Result acceptance locks the command, exact command run set, plan, and current action before terminal compare-and-swap and aggregation.

For an existing command, the deterministic lock order is command row, complete command run set ordered by `(actionId, runId)`, plan row, then relevant Action rows ordered by ID. Claim-next selects and locks a candidate command with `FOR UPDATE SKIP LOCKED`, then follows that order and revalidates the selected run. Exact claim, start, and result first resolve IDs without mutation, then lock in the same order. Simultaneous sibling results therefore serialize on the command row rather than taking sibling run locks in opposite order. Serialization/deadlock errors are bounded retryable persistence failures and never return success before commit.

All statements use Prisma or parameterized SQL; identifiers and predicates are never assembled from request strings. Database errors never fall back to memory for this protocol. The endpoint returns an unavailable or persistence error and never claims durability.

### Controlled migration execution

Phase 2E DDL is never added to `TABLE_DEFINITIONS` or applied by ordinary web/worker startup. Under the approved Migration Gate, one explicit out-of-band migration artifact is created with a recorded checksum/version and a pinned session-level advisory lock held across transactional and nontransactional concurrent-index phases. The durable migration ledger records phase/checksum state and invalid-index recovery. Ordinary startup performs read-only schema/version/constraint verification; the protocol remains disabled and fail-closed when verification is absent or inconsistent. Application remains restricted to a dedicated local ephemeral PostgreSQL database until Gate D is separately approved.

At the local implementation checkpoint, the migration planner, checksum/verifier, fault-injection model, and compensating-path tests run without a database, but no local PostgreSQL server or container runtime is available. Consequently, actual PostgreSQL apply, rerun, advisory-lock contention, old-application/new-schema compatibility, and compensation execution remain unverified runtime prerequisites for Gate D; no database was mutated under this limitation.

The forward migration is additive and phased:

1. record bounded row counts and query plans;
2. set explicit lock and statement timeouts;
3. add nullable plan provenance/generation columns;
4. build existing-table unique indexes with the least-blocking Postgres mechanism supported, normally `CREATE UNIQUE INDEX CONCURRENTLY`, then verify validity;
5. create new tables, checks, and foreign keys transactionally;
6. record the migration checksum only after every constraint is valid; and
7. rerun a read-only equivalence check.

Because concurrent index creation cannot run inside the table-creation transaction, the migration tool records each phase and refuses partial activation. No service startup retries or completes migration phases.

### Migration risk and compatibility

- Classification: additive; no historical rewrite or destructive backfill.
- Old application with new schema: storage-compatible; it ignores nullable columns and new tables, but must never overlap traffic with activated Phase 2E command semantics.
- New application with missing schema: protocol disabled/fail-closed; no cache fallback.
- Existing rows: unchanged and explicitly legacy/unknown.
- Locking risk: existing-table indexes scan ActionPlan/Action. Preview row counts, plans, lock timeouts, and concurrent read/write behavior must be measured before any production proposal.
- Startup: Prisma/runtime types include the additive schema, but startup performs verification only and no DDL.
- Preview rollback: disable new command creation, keep claim/start/result/status in drain mode until zero nonterminal runs, then revert application. A compensating schema drop is preview-only and requires retained-evidence review.
- Production rollback proposal: leave additive schema in place; no destructive down migration. No production action is authorized in Phase 2E.

Gate D evidence must include exact forward and compensating SQL, checksum, row counts, `EXPLAIN`, timeouts, index-validity checks, FK/delete tests, migration rerun equivalence, partial-failure recovery, concurrent web/worker startup proving no DDL, old-app/new-schema validation, and a drain/rollback rehearsal.

Gate A and the Migration Gate authorize the forward/compensating SQL, Prisma/runtime schema representation, migration tests, and application only to dedicated local ephemeral databases. Gate D must separately authorize applying the already-reviewed migration to an isolated Railway preview. No approval recorded in this document authorizes a staging, preview, or production migration.

## Python protocol behavior

The new Python path is a dedicated executor poller and protocol client, not the generic daemon command/result facade. It obtains a versioned run assignment through authenticated claim-next rather than a loose whole-plan callback.

It must:

1. load the operator-configured expected realm and confirm the authenticated Phase 2E capability reports the same realm;
2. durably record a claim idempotency key before claim-next;
3. claim one run with its dedicated per-instance credential;
4. verify and durably store the execution realm, plan ID, action ID, opaque snapshot ID, exact bounded immutable assignment, lifecycle facts, CLEAR facts, executor kind, and assignment shape;
5. durably record start intent, call start, and verify `RUNNING` before any local command;
6. persist local-execution-started before invoking exactly the assigned immutable snapshot;
7. durably store the bounded exact result request and result key before submission;
8. submit the real result to the dedicated result endpoint;
9. inspect `BackendResponse.ok`, structured acceptance state, and key-bound receipt;
10. treat exact accepted replay as success;
11. treat conflicts, stale state, owner rejection, realm rejection, malformed response, and unknown acceptance as non-success; and
12. emit completion or acknowledge durable completion only after accepted or proven idempotent terminal state.

It never falls back to `/execute` for result submission.

The daemon stores a small dedicated SQLite execution journal under its configured data directory. It is not the agentic history database. The journal contains the pinned expected realm, run/command/snapshot IDs, exact bounded immutable assignment, claim/start/result keys, exact bounded pending result request, acceptance receipt, and local state. It contains no backend credential, authorization header, complete plan, or unrelated payload.

Journal initialization and every atomic transition fail closed unless the file and directory have verified current-user-only access under the host platform's permission model. “Best effort” permissions are insufficient because the journal contains executable assignment and result material. The journal is never logged. The assignment and pending result body are deleted after durable acceptance while the minimal IDs/receipt required for audit-safe recovery remain according to the bounded local retention policy. Any local checksum protects journal integrity only and is not an authorization or backend replay decision.

Structured dispositions are:

- `ACCEPTED` or `CONFIRMED_REPLAY`: safe to emit completion and retire the local pending result;
- `RETRY_RESULT`: retain the same request/key and do not acknowledge;
- `RECOVERY_REQUIRED`: do not execute or acknowledge; query authenticated status;
- `QUARANTINED_REJECTION`: stop automatic retry, emit a sanitized diagnostic, and do not acknowledge success; and
- `PROTOCOL_INCOMPATIBLE`: do not execute, submit, or acknowledge.

After a process restart:

- a pending result is retried with the same stored key and exact stored body;
- a matching key-bound terminal receipt may be acknowledged after authenticated status confirmation;
- a `CLAIMED` run with the exact stored assignment and no local start record may safely resume start with the stored key;
- a `RUNNING` run whose journal retains the exact assignment and proves local execution never began may proceed only after authenticated state and pinned-realm confirmation;
- a run with local execution started but unknown effect/result is quarantined, not re-executed and not acknowledged; and
- no lease or silent reassignment is inferred.

Legacy generic-queue `action_plan` commands are incompatible with Phase 2E and are never translated into result-through-`/execute`. The canonical and legacy generic daemon dispatchers must not acknowledge such a command as durable execution. No in-repository producer was found, so the initial Phase 2E delivery path is claim-next only.

## Compatibility position

| Client/backend combination | Required behavior |
|---|---|
| New Python + Phase 2E backend | Claim and submit through dedicated operations |
| New Python + legacy backend | Fail closed as incompatible; never use `/execute` for results |
| Legacy Python + Phase 2E backend | Result-shaped `/execute` is rejected and never dispatches |
| Legacy Python + legacy backend | Preserved only by deploying old code; remains unsafe |
| Unknown MCP command client + Phase 2E | `plans.execute` remains command-only with an explicit idempotency key |

The Python package is distributable, but publication and active installations were not proven. Production rollout must therefore treat legacy clients as unknown. Because the current daemon queue is anonymous, production activation is blocked until old executors are inventoried or disabled and the dedicated credential is configured.

The protocol is default-off behind separate server controls: `ACTION_PLAN_EXECUTION_PROTOCOL_V2_ENABLED`, `ACTION_PLAN_EXECUTION_ACCEPT_COMMANDS`, `ACTION_PLAN_EXECUTION_ASSIGN_REQUESTED`, and `ACTION_PLAN_EXECUTION_DRAIN_ENABLED`. A disabled protocol rejects result-shaped `/execute` with `ACTION_PLAN_RESULT_ENDPOINT_REQUIRED` and rejects command requests with `ACTION_PLAN_EXECUTION_PROTOCOL_DISABLED`; it never falls back to synthetic success. Command acceptance, new claim-next assignment, and exact-claim/start/result/status recovery can therefore be disabled independently. Rollback first disables commands, keeps assignment on until zero `REQUESTED` runs, then disables assignment while drain remains on until zero `CLAIMED`/`RUNNING` runs. Activation is a breaking HTTP/MCP change and requires explicit operator acceptance.

No mixed-version request pool is permitted. Before activation, every old web replica and legacy Python executor must be drained or stopped, pending generic `action_plan` commands must be proven absent, the schema checksum must verify, and every active web replica must identify the same Phase 2E protocol version. New Python never receives work until these checks pass.

## Threat model and required decision tests

| Threat | Required control | Required test evidence |
|---|---|---|
| Result invokes execution | Separate strict routes and schemas | Result request causes zero execution/dispatch/new run |
| Failed action becomes success | Submit actual terminal outcome to bound run | Python failure remains backend `FAILED` |
| One result updates siblings | One action per run | Sibling runs/results unchanged |
| Duplicate command dispatches twice | DB command uniqueness and transaction | Same-key concurrency produces one run set |
| Different keys/transports create duplicate attempts | Global active plan/action uniqueness | Different-key and HTTP/MCP concurrency creates one active run |
| Conflicting result overwrites terminal evidence | Terminal CAS and fingerprint comparison | First terminal result remains immutable |
| Wrong executor reports | Server-derived principal and owner predicate | Wrong principal performs zero mutation |
| Preview result reaches production | Server-derived realm predicate | Cross-realm submission performs zero mutation |
| Executor never receives a run | Authenticated claim-next | One assigned instance can claim; others receive no assignment |
| Plan becomes blocked before start | Locked lifecycle/CLEAR/generation recheck | Claim/start returns no executable assignment |
| Action changes after authorization | Immutable snapshot plus generation recheck | Stale snapshot rejected before start and never aggregated after start |
| Result overwrites concurrent block | Plan-state/generation CAS | Run evidence persists while blocked plan remains blocked |
| Legacy result repeats a real effect | Legacy evidence denial | Command creates zero runs for plans with legacy results |
| Database failure appears successful | No cache fallback | Partial/event/write failure returns failure and rolls back |
| Response loss causes duplicate local execution | Stable result key and status recovery | Retry returns accepted state without a second effect |
| Process restart repeats unknown local effect | Fail-closed restart rule | Running/unknown local state is not re-executed or acknowledged |
| Payload or secret disclosure | Strict bounded schema and allowlisted logs/events | Sentinel, header, path, SQL, provider, and raw-result scans remain clean |
| Legacy anonymous route bypasses new authority | Router-wide ActionPlan/agent mutation auth | Wrong role and anonymous requests perform zero reads/mutations |

## Approved local implementation and remaining rollout gates

1. Add shared decision fixtures and failing contract tests.
2. Add the default-off ambiguous-`/execute` guard and authentication decision tests; no result body can reach legacy execution semantics.
3. Create the reviewed additive migration and rollback artifact only after separate migration approval.
4. Implement the transaction-backed domain repository and pure state decisions.
5. Implement command, claim-next/exact claim, start, result, status, bounded result read, OpenAPI, and requester-only MCP adapters.
6. Update Python capability, dedicated client, claim, start, local journal, result, retry, and acknowledgement behavior.
7. Run full local TypeScript/Python, fault-injection, OpenAPI, disclosure, dependency, and migration validation.
8. Present Gate C for a fresh isolated preview based on `phase2d-validation-20260717`.
9. Present Gate D before applying the preview migration or deploying.
10. Present Gate E before activating one bounded no-op Python executor.
11. Present Gate F separately for push, pull request, production, or teardown.

## Independent rollback boundaries

- Documentation and tests: revert their commits.
- Command adapter: first disable new command creation. Never restore an externally reachable adapter that lets a result invoke execution or fabricates success.
- Result/claim/start/status adapters: keep the compatibility/drain build available until the database reports zero `REQUESTED`, `CLAIMED`, or `RUNNING` runs, then disable and revert adapter commits. A local Python quarantine is not backend settlement. If an unknown-effect run cannot settle, keep the drain build or stop public reachability; do not remove the adapters.
- Python: revert the client commit only together with disabling Phase 2E assignment; never restore result fallback against a Phase 2E backend.
- Migration: leave additive tables in place after application rollback. Use the compensating drop only in an isolated preview after evidence retention approval.
- Preview: stop new assignments, drain/quarantine runs, disable the executor, and roll back only to a Phase 2E compatibility build that retains the ambiguous-route guard. If no such build is healthy, remove public reachability or stop the isolated preview rather than exposing the old defect. Delete only after Gate F approval.
- Production: no Phase 2E production deployment or migration is authorized, so no production rollback should be necessary.

## Approved Gate A and Migration Gate decision

The operator approved all of the following as one coherent local implementation design at branch `codex/action-plan-execution-ownership`, commit `5e8ef46f48adea6eca82b4fd919821c939cca6c6`:

1. explicit hybrid ownership with only `terminal.run -> python-daemon` initially supported;
2. command-only `/execute` plus dedicated claim-next/exact claim, start, result, status, and bounded-result operations;
3. purpose-bound requester, operator, HTTP MCP requester, and per-instance executor identities with the operation matrix above;
4. authentication or disablement of legacy plan/result/lifecycle and agent-mutation bypasses;
5. Railway-ID-derived realms plus realm/requester/generation provenance on new plans; legacy plans remain non-executable;
6. immutable opaque action snapshots instead of a public digest over arbitrary command material;
7. additive plan columns and command/run/event persistence with the listed foreign keys, checks, and global active-run index;
8. out-of-band checksummed migration with read-only startup verification, never runtime bootstrap DDL;
9. transaction/CAS idempotency, command-scoped aggregation, concurrent-block preservation, and terminal monotonicity;
10. no automatic reassignment, partial selection, cancellation, or retry endpoint in the first implementation; and
11. fail-closed Python dedicated client, local journal, restart recovery, capability, and acknowledgement behavior.

Gate A authorizes local production-code implementation and tests for this design. The additive Migration Gate authorizes creating the migration artifacts and applying them only to local ephemeral databases. Neither approval authorizes credential configuration, Railway configuration, preview creation, preview migration, deployment, executor activation, external-provider calls, push, pull request, merge, production change, or teardown.
