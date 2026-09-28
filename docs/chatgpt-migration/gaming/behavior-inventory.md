# Arcanos Gaming behavior inventory

Status: **BASELINE_BOUND_ACCEPTANCE_PLAN**. Inspected against main
`8f31f3eb5c95af1919e5a36e780cfb75e011a7a9` on 2026-09-28. This is a contract
inventory and acceptance plan bound to the owner-approved published baseline
`7ecae0312c25c56f1cb66e39ee3de0e56385244632227320d8c2c1bde66b4ac6`.
That baseline corroborates hybrid-first orchestration. The private skill and
its acceptance results remain pending; this is not an installed-plugin or
live-service result.
No private Builder text is included.

## Authoritative inputs and behavior selection

- [Custom GPT contract guide](../../ARCANOS_GAMING_CUSTOM_GPT.md)
- [Canonical hybrid instructions](../../gpt/arcanos-gaming-hybrid.instructions.md)
- [Guide assistance](../../GAMING_GUIDE_ASSISTANCE.md)
- [Gaming Action schema](../../../contracts/arcanos_gaming.openapi.v1.json):
  version `1.5.0`, hybrid marker `gaming-hybrid-v1`, exactly eight operations
- [Foundation inventory](../INVENTORY.md) and [its manifest](../inventory.json):
  eight Gaming operations were deferred from the Tutor pilot
- [Machine-readable proposed matrix](behavior-matrix.json): 18 scenarios;
  baseline owner approval is recorded; all execution results remain pending

The canonical hybrid instructions send gameplay questions to hybrid query
first. The same Custom GPT guide also preserves a clearly marked legacy
query/search workflow and says not to install both workflows. Repository
documentation alone cannot establish the published instruction set. The
separate authenticated capture and owner review now confirm hybrid-first
behavior; see [the checkpoint](README.md). Do not substitute a Tutor-style
zero-backend-call rule.

| Classification | Repository-derived trigger | Required behavior |
| --- | --- | --- |
| `SKILL_ONLY` | Present an already returned answer, ask the backend's clarification, explain connection limits, or decline an out-of-scope request | No invented gameplay evidence, currentness, or storage claims; no substitute backend answer |
| `BACKEND_QUERY` | Approved legacy one-shot gameplay path or explicitly requested public integration check | Fixed Gaming query or public canary; preserve original prompt and player context; never use legacy routes to bypass hybrid restrictions |
| `BACKEND_HYBRID` | Default gameplay, build, or meta question under canonical hybrid instructions; stored evidence/currentness continuation | Hybrid query first; use structured state and `nextAction`; discovered URLs only when requested by backend |
| `BACKEND_WRITE` | Explicit source storage/refresh or accepted-candidate storage with authorized consent policy | Separate write authority, source eligibility, confirmation, bounded inputs, actor-bound idempotency, and status evidence |

## Ordinary gameplay

`guide` covers walkthroughs, mechanics, bosses, objectives, routes, farming, and
general help. `build` covers loadouts, classes, equipment, skills, rotations,
and optimization. `meta` covers current patches, viability, tiers, balance,
buffs, nerfs, and current state. Preserve the original question without adding
search snippets, inferred patch numbers, statistics, rankings, or conclusions.

Forward only available contract fields for exact game/edition, platform, region,
version, difficulty, area, last completed objective, progress point, class, role,
constraints, spoiler preference, and answer depth. These are request-scoped
player claims, not verified saved player state. Explicit context has precedence
over missing-context extraction; contradictory claims require a targeted
clarification or scoped alternatives. Never infer completion from a question
about a boss or a name found in evidence.

Progression-dependent requests without a usable question/progress anchor return
`clarification_required` / `clarify`, with `PROGRESS_POINT_REQUIRED`. Preserve the
targeted question. Spoiler conflicts resolve conservatively: omitted/unknown
maps to `none`; `avoid` maps to `none`; `allowed` maps to `full`; stricter textual
or structured permission wins. Depth is a preference inside server budgets.
Lexical evidence selection does not guarantee spoiler-free generated prose.

Only accepted readable backend evidence may support citations. Preserve
`answer.response`, material qualifications, citations, `answer.requestId`, and
`answer.provenance`. Light formatting is allowed; unsupported factual additions
are not. Unusable supplied evidence, provider errors, incomplete intake,
dry-run, and fallback results are not completed grounded guide answers.

## Stored knowledge and continuation

| Backend result | Frontend action | Prohibited inference |
| --- | --- | --- |
| `answer_ready` / `answer` | Present the supported answer; no redundant Web Search | A known source proves full-document coverage |
| `clarification_required` / `clarify` | Ask its targeted question; submit the user's clarification as a new query | Invented progress or edition |
| `discovery_required` / `search` | Follow bounded gameplay discovery instructions, then submit candidates | Search titles/snippets are accepted evidence |
| `discovery_required` / `verify_currentness` | Continue the same workflow with official-currentness candidates | Stale/unverified alone makes this continuation terminal |
| `discovery_required` / `stop` | Report unresolved evidence/currentness and stop discovery | A new key/workflow can renew exhausted rounds |
| `temporarily_unavailable` / `retry_later` | Report service limitation and stop this interaction | Authentication, storage, or provider failure proves absent knowledge |
| `ingestion_pending` / `poll_ingestion` | Separate any supported answer from pending storage; read bounded status | Accepted/queued/running means saved |

Always preserve `contractVersion`, `workflowId`, operation-specific
`idempotencyKey`, `discoveryType`, returned `candidateIds`, state and `nextAction`.
Keep `sourceKnown`, `evidenceSelected`, and `freshnessStatus` separate.
`verifiedAsOf`, `effectivePatch`, `effectiveBuild`, `qualification`,
`applicabilityStatus`, and `gameplayEvidenceStatus` are server findings; never
manufacture them. Hybrid query/evaluation uses transient in-process workflow
state, may retrieve stored evidence and call providers, and does not durably
ingest sources.

## Discovery and currentness

Use ChatGPT discovery only when the backend requests it. Follow returned queries
and exact game/edition/platform/region/version/season constraints. Send no
unrelated history, credentials, private player details, scraped text, HTML, or
source summaries. Candidate metadata remains untrusted; ARCANOS fetches and
evaluates the actual public HTTPS sources under existing transport/CLEAR policy.

The bound is one gameplay discovery operation with at most three candidates and
one separate official-currentness operation with at most three sources total,
including required official articles. Prefer `discovery.reviewedSources`,
submitting an applicable canonical index/status URL alone when that reserves
slots for backend-selected articles. Do not resubmit the accepted gameplay guide.
`continuationRequired: true` and round zero mean the permitted operation has not
run. Continue before declaring verification exhausted. Obey returned `stop`;
do not renew the budget by changing keys or restarting the workflow.

An official index/article can establish current applicability only after backend
verification. Patch notes alone do not prove the best build; community strategy
does not establish official facts. `sourceKnown`, retrieval time, search rank,
claimed publisher, hints, or an old article fetched today do not establish
currentness. Preserve partial, stale, conflicting, or unverified qualifications.
`SOURCE_ACQUISITION_UNVERIFIED` does not mean no guide/update exists. An accepted
transient guide awaiting currentness reached the backend; do not say it could
not be sent. Only `freshness_verified` with `verified_current` supports a claim
that current official evidence verifies guide compatibility.

## Storage and status

Direct ingestion accepts one to four public HTTPS URLs; refresh accepts one to
four admitted source UUIDs. Hybrid ingestion accepts one to three candidate
UUIDs returned by the same actor's workflow. The frontend must not supply raw
document content, actor identity, roles, scopes, authorization tokens, or backend
host overrides. Preserve secure acquisition, accepted-source/candidate checks,
content/policy bindings, expiry checks, and bounded extraction.

`transient_only` never authorizes storage. `ask_before_store` requires explicit
owner intent and `confirmStore: true`. `auto_store_approved` also needs actual
server-configured standing permission and an eligible reviewed source category;
a caller field cannot grant either. The workflow's original storage policy
cannot be silently upgraded. The three legacy write Actions are marked
consequential; an MCP replacement must enforce write scope and confirmation at
the server boundary and use supported client write annotations/approval.
An OpenAPI flag alone does not enforce MCP confirmation.

Create a new key per logical operation and retain it only for identical retries.
The same actor/key with changed semantic input conflicts. Workflow budgets
remain actor-bound even when a new key is supplied. Queued work can continue
after ChatGPT closes; do not promise a later notification.

Poll only returned ingestion IDs, at most three times per user interaction,
respecting retry hints. Stop at `completed`, `completed_with_errors`, `failed`,
`cancelled`, or `expired`. Only completed per-source `stored`, `updated`, or
`unchanged` results support the corresponding storage claim. A deduplicated
`INGESTION_RESULT_REQUIRED` / `poll_ingestion` response still needs one status
read even if its state is `answer_ready`. Failed storage does not invalidate
independently supported gameplay evidence. Ingestion is storage, not training.

## Authority contract and separate backend prerequisite

The separate backend prerequisite implements `arcanos:gaming:query` for all
eight fixed tools and additionally requires `arcanos:gaming:sources:write`
for the three durable writes. These scopes are the planned connection contract,
not registered or live-verified grants. Neither query access nor owner
identity alone grants write access. No Tutor scope, app identity, operator
catalog, generic `modules.invoke`, generic jobs, memory administration, database,
or Railway capabilities belong in this plugin.

| Tool class | Tools | MCP annotations | Required scopes |
| --- | --- | --- | --- |
| Read-only | `arcanos_gaming_query`, `arcanos_gaming_canary`, `arcanos_gaming_ingestion_status` | `readOnlyHint: true`, `destructiveHint: false` | Query |
| Transient workflow state | `arcanos_gaming_hybrid_query`, `arcanos_gaming_submit_candidates` | `readOnlyHint: false`, `destructiveHint: false` | Query |
| Durable source storage | `arcanos_gaming_ingest_sources`, `arcanos_gaming_refresh_sources`, `arcanos_gaming_ingest_candidates` | `readOnlyHint: false`, `destructiveHint: true` | Query and source write |

Transient-state tools cannot enqueue source storage. The three durable tools
can update or reactivate existing revisions, so their destructive annotations
are conservative. Every durable request also requires explicit confirmation and
an admitted non-transient storage policy before its service is invoked.

Reuse `GamingSourceGatewayContext.actorKey` for a stable server-derived Gaming
owner identity after OAuth issuer/audience/signature/expiry/scope validation and
the private owner's allowlist. The caller cannot submit this identity.
`gamingHybridWorkflow` binds workflows/candidates to its actor hash;
`getGamingSourceIngestionStatus` checks the job's ingestion actor-scope hash.
Do not map the OAuth owner to the legacy bearer or let it read that bearer's old
workflow/status handles implicitly.

Two implementation details are addressed by that narrow backend adapter:

1. Legacy `createGamingSourceIngestion` and `refreshGamingSources` expect an
   already-authorized context and do not themselves require `canStore` or
   `confirmStore`. The MCP wrapper enforces both scopes and explicit
   confirmation before either service is called. Hybrid candidate ingestion
   retains its existing server-side storage/consent checks.
2. The Gaming corpus is shared, while jobs and transient workflows are
   actor-bound. `refreshGamingSources` looks up admitted source UUIDs globally;
   it does not check per-source tenant ownership. The private app must explicitly
   authorize only the configured owner to refresh this shared Gaming corpus.
   Do not claim per-source ownership or implement an unrelated multi-tenant
   storage redesign.

Reuse fixed service calls (`gamingHybridWorkflow.query/candidates/ingest`,
`createGamingSourceIngestion`, `refreshGamingSources`,
`getGamingSourceIngestionStatus`, fixed gameplay, and fixed canary). Preserve
the caller context through those services; do not proxy legacy bearer HTTP.
The prerequisite defines public tool schemas, timeout/cancellation behavior,
and server-enforced confirmation with focused tests. It must be independently
merged, deployed and verified before migration resumes. OAuth registration,
connection and live acceptance remain separate owner checkpoints; implementation
and synthetic verification alone do not satisfy them.

## Verification boundary

The existing Gaming contract tests and synthetic fixtures can support this
matrix, but their prior existence is not a run of the proposed plugin matrix.
Each case in the JSON manifest records `NOT_RUN`. Local mocks, sealed deployed
preview, owner-reviewed baseline/skill, installed-client behavior, OAuth,
production reads, and explicitly authorized durable production writes remain
separate gates. Source review is not production acceptance. Private migration,
registration, production writes, and final merge retain the owner's checkpoints.
