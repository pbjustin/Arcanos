# Four-GPT migration inventory

For current Tutor-only connection metadata and migration gates, use the
[standalone Tutor handoff](TUTOR_MIGRATION.md). This dated foundation inventory
does not update the other GPTs or represent a captured Builder export.

This maintained companion and [machine-readable manifest](inventory.json) describe
repository contracts inspected on 2026-09-22 at
`655cb56fc3912684a0dd7b7bfb735a841f3c4056`. They support the scoped Tutor
migration; they are not exports of the user's saved GPTs. Source implementation,
local tests, deployments, registered connections and installed client behavior
are separate evidence. See [architecture](ARCHITECTURE.md),
[authentication](AUTHENTICATION.md), and [platform requirements](PLATFORM.md)
for the connection decision and its limitations.

Local checks and independent-review findings are recorded in the
[dated verification report](../audits/chatgpt-migration/2026-09-22.md).

**Coverage:** 44 unique operation IDs across 45 contract occurrences: Gaming 8,
Booker 5, canonical GPT route 2, bridge 5, generated GPT Access 25.
`canaryArcanosGaming` appears in two contracts. Every operation has an explicit
disposition below and detailed effects, identifiers, permissions and lifecycle
notes in the manifest. A gateway/bridge operation in source does not establish
that the published ARCANOS or Tutor GPT currently imports it.

**Disposition:** REUSE retains a backend service or contract; WRAP creates a
narrow authorized entry to it; DEFER retains the existing operation for a later
scope; BLOCKED requires an unresolved authority or account decision. WRAP on
`invokeGptRoute` means only its default Tutor module query semantics, not an
MCP copy of that broad HTTP Action.

## GPT and reference reconciliation

| GPT | Verified repository binding | Repository instruction/reference sources | Published Builder and uploads | This PR |
| --- | --- | --- | --- | --- |
| ARCANOS TUTOR | `ARCANOS:TUTOR`; route `tutor`; IDs `arcanos-tutor`, `tutor` | `src/platform/runtime/tutorPrompts.ts`, `src/core/logic/tutor-logic.ts`, `docs/CUSTOM_GPTS.md` | Full saved text and uploaded knowledge inventory UNKNOWN | Prompt-only synchronous default query pilot |
| Backstage Booker | `BACKSTAGE:BOOKER`; route `backstage-booker`; IDs `backstage-booker`, `backstage` | `docs/BACKSTAGE_BOOKER_GPT_BUILDER_INSTRUCTIONS.md`, `docs/BACKSTAGE_BOOKER_CUSTOM_GPT.md`, server CLEAR policy | Full saved text/uploads UNKNOWN; private universe and Notion content not exported | Inventory and follow-up scope |
| ARCANOS | `ARCANOS:CORE`; route `core`; IDs `arcanos-core`, `core`, `arcanos-daemon` | `docs/CUSTOM_GPTS.md`, `docs/gpt-access-gateway.md`, Core service | Saved Action selection, full text and uploads UNKNOWN | Conversation/control inventory and follow-up scope |
| Arcanos Gaming | `ARCANOS:GAMING`; route `gaming`; IDs `arcanos-gaming`, `gaming` | `docs/ARCANOS_GAMING_CUSTOM_GPT.md`, `docs/gpt/arcanos-gaming-hybrid.instructions.md`, guide assistance | Saved hybrid activation and uploads UNKNOWN | All eight Actions inventoried |

Bindings are explicit in [moduleCatalog.ts](../../src/services/moduleCatalog.ts)
at lines 133-145, 190-194 and 204-208. The gateway additionally canonicalizes its
exact compatibility alias `arcanos` to `arcanos-core`; this is not a catalog
GPT ID. Runtime overrides remain deployment configuration, not inspected live
Builder evidence.

No uploaded knowledge filenames, contents or account/app IDs were supplied.
The missing assets for **each** GPT are its published Builder export, uploaded
file inventory (safe metadata such as filename/size/hash), and authorized
private reference contents for reconciliation. Keep those exports outside this
public repository. Repository runtime prompts are not uploaded knowledge.
Gaming's runtime public sources and canary fixture are not proof of GPT file
coverage. Booker's PostgreSQL/Notion authority is a backend data dependency,
not an invitation to export private universes or bypass authority with direct
Notion access. No reference file or tool absent from this PR is declared by
the Tutor package.

## Tutor semantics and service reuse

[ArcanosTutor.actions.query](../../src/services/arcanos-tutor.ts) calls the real
[handleTutorQuery](../../src/core/logic/tutor-logic.ts) pipeline. The default
runtime prompts teach step by step, preserve direct-answer instructions, and
retain the exact-literal shortcut. The pilot accepts one bounded `prompt` and
returns model-readable `answer` plus public execution metadata through
`arcanos_tutor` at `/chatgpt/mcp`.

The legacy Tutor action also has domain/module selectors for educational
`memory/explain`, educational `memory/audit`, `logic/clarify`, and scholarly
`research/findSources`. These selectors and research augmentation are DEFERRED,
as are the legacy HTTP queue and transcript modes. They are not arbitrary
backend module execution.

The distinction matters: [gptRouter.ts](../../src/routes/gptRouter.ts#L271)
marks only Gaming query as direct; an explicit Tutor HTTP `action=query`
uses durable GPT work. The direct Tutor module pipeline itself requires no
queue. [gptDispatch.ts](../../src/routes/_core/gptDispatch.ts#L1996) can invoke
conversation persistence, which
[moduleConversationPersistence.ts](../../src/services/moduleConversationPersistence.ts#L65)
skips without an explicit session. The new pilot wraps the synchronous default
module action, not the broad route orchestration; it exposes no queue
continuation, job ID or retry/idempotency capability.

Absence of a session alone was insufficient to prevent all lower-level memory
work: Trinity initialized memory before its normal session check. The isolated
Tutor execution policy disables memory access before initialization, optional
pattern/judged/self-improvement effects, and private audit retention. It also
clears inherited conversation context and evaluates HRC without shared cache
or provider storage. This is a server-owned execution choice, never a tool
argument. Errors return sanitized outcomes instead of private exceptions.
The existing GPT routes retain their ordinary execution policy.

Mock/provider-unavailable behavior must remain labeled as such; a deterministic
fixture or shortcut is not evidence of a model call. Timeout/disconnect responses
must not expose partial private diagnostics or start replacement jobs.

## Authentication and ownership findings

- Existing HTTP and stdio MCP entry points exist:
  [routes/mcp.ts](../../src/routes/mcp.ts#L77) and
  [mcp/context.ts](../../src/mcp/context.ts#L193). HTTP uses the distinct
  `MCP_BEARER_TOKEN`; it is the operator interface, not per-user OAuth.
  `modules.invoke` requires an explicit
  [module-action allowlist](../../src/mcp/modulesAllowlist.ts#L45) and confirmation.
  The new boundary must never inherit that catalog or its operator identity.
- [MCP job tools](../../src/mcp/server/jobTools.ts#L35) directly call
  `getJobById` and exclude protected local-agent jobs. They do not provide
  OAuth-principal ownership or the public HTTP exact-job capability policy.
  [GPT Access job reads](../../src/services/gptAccessGateway.ts#L1025) distinguish
  gateway provenance and device owners. Reuse their owned paths only after an
  explicit OAuth identity adapter; do not copy the broad operator case.
- Gaming's [source authentication](../../src/services/gamingSourceAccessAuth.ts#L86)
  derives its actor from a purpose-bound credential. Ingestion status checks the
  same actor scope. Hybrid storage separately enforces eligibility, permission,
  standing permission where applicable, and consent:
  [gamingHybridCandidates.ts](../../src/services/gamingHybridCandidates.ts#L319).
  Replacing this with blanket permission for every JWT subject would broaden
  authority.
- Booker authentication establishes a private request marker and server-owned
  [registered client identity](../../src/services/backstageBookerAccessAuth.ts#L110).
  Runtime model claims and GPT display names are not credentials. The shared
  legacy bearer establishes one trust domain; exact `universeId` is scope, not
  per-user membership. New connections need an explicit universe ACL.
- MCP transport session IDs, ARCANOS `sessionId`, jobs and universe IDs are
  different identifiers. [Hydration](../../src/services/sessionContextHydrationService.ts#L28)
  reads exactly `conversations_core` only after dispatch establishes
  `memoryPlaneAuthorized`, eligible action and explicit session.
  Defaults are 12 turns, 8,000 characters and a 1,000 ms read timeout; supported
  maxima are 100 turns and 64,000 characters. Failed reads are bounded/fail-open.
  [Historical role labels](../../src/shared/memory/sessionContextCore.ts#L24)
  remain untrusted data, not instructions. The deployment-wide memory credential
  does not establish user ownership. Pilot hydration stays unavailable; neither
  a supplied ID nor ChatGPT memory substitutes for backend authority.

All source references above describe executable boundaries, not a claim that a
specific deployment currently has matching credentials, flags or data.

## Operation dispositions

The following tables list every operation ID in the inspected Action schemas.
The manifest adds exact contract source lines, authentication profiles, actual
effects, identifiers, retry/pending/error behavior and per-operation reasons.
Deferred proposed tools are future dedicated wrappers only; they are not
registered or declared in the Tutor package.


### Shared writing Action

| Operation ID | Method and endpoint | Disposition | Effects / migration reason |
| --- | --- | --- | --- |
| `invokeGptRoute` | `POST /gpt/{gptId}` | WRAP | generation; explicit-query queue; explicit-session transcript/history writes. Default Tutor subset only; legacy route preserved. |

### Gaming: complete eight-operation workflow

| Operation ID | Method and endpoint | Disposition | Effects / migration reason |
| --- | --- | --- | --- |
| `queryArcanosGaming` | `POST /gpt/arcanos-gaming` | DEFER | generation; public retrieval; optional audit/HRC. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `canaryArcanosGaming` | `POST /gpt/arcanos-gaming/canary` | DEFER | deterministic fixture validation only. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `ingestGamingSources` | `POST /gpt-access/gaming/sources/ingestions` | DEFER | durable job; source fetch; source/chunk writes. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `refreshGamingSources` | `POST /gpt-access/gaming/sources/refreshes` | DEFER | durable job; source fetch; atomic revision writes. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `getGamingSourceIngestionStatus` | `GET /gpt-access/gaming/sources/ingestions/{ingestionId}` | DEFER | actor-bound sanitized ingestion read. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `queryGamingHybridKnowledge` | `POST /gpt-access/gaming/sources/hybrid/query` | DEFER | stored evidence read; transient workflow; conditional provider/currentness work. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `submitGamingHybridCandidates` | `POST /gpt-access/gaming/sources/hybrid/candidates` | DEFER | bounded URL validation; transient decisions; conditional generation. Gaming full workflow follow-up; no Gaming tools in pilot. |
| `ingestGamingHybridCandidates` | `POST /gpt-access/gaming/sources/hybrid/ingestions` | DEFER | existing ingestion queue; durable eligible source/chunk writes. Gaming full workflow follow-up; no Gaming tools in pilot. |

### Booker: generation, continuation, reads and canon

| Operation ID | Method and endpoint | Disposition | Effects / migration reason |
| --- | --- | --- | --- |
| `runBackstageBooker` | `POST /gpt/backstage-booker` | DEFER | continuity reads; generation proposals; simulation; heavy-generation durable jobs. Booker authority/provenance and owned-continuation follow-up. |
| `getBackstageBookerJobResult` | `GET /gpt-access/capabilities/v1/backstage-booker/jobs/{jobId}/result` | DEFER | protected managed job read/wait. Booker authority/provenance and owned-continuation follow-up. |
| `writeBackstageCanon` | `POST /gpt-access/capabilities/v1/backstage-booker/run` | BLOCKED | durable storyline upsert; immutable canon append; mutation receipts. Needs verified per-user exact-universe authority and supported approval/enforcement design. |
| `getBackstageUniverse` | `GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}` | DEFER | bounded exact-universe PostgreSQL read. Booker authority/provenance and owned-continuation follow-up. |
| `getBackstageStoryline` | `GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary` | DEFER | bounded exact-storyline PostgreSQL read. Booker authority/provenance and owned-continuation follow-up. |

### ARCANOS: generated gateway contract

| Operation ID | Method and endpoint | Disposition | Effects / migration reason |
| --- | --- | --- | --- |
| `createDevicePairing` | `POST /gpt-access/devices/pairing` | DEFER | durable single-use pairing challenge. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `pairDevice` | `POST /gpt-access/devices/pair` | DEFER | durable device registration; credential issuance. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getDeviceSession` | `GET /gpt-access/devices/session` | DEFER | own device metadata read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `renewDeviceCredential` | `POST /gpt-access/devices/renew` | DEFER | durable credential rotation. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `revokeDevice` | `POST /gpt-access/devices/{deviceId}/revoke` | DEFER | durable device revocation. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `arcanosAccessHealth` | `GET /gpt-access/health` | DEFER | sanitized operational read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getRuntimeStatus` | `GET /gpt-access/status` | DEFER | sanitized runtime read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getWorkersStatus` | `GET /gpt-access/workers/status` | DEFER | worker/queue-observed read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getWorkerHelperHealth` | `GET /gpt-access/worker-helper/health` | DEFER | worker helper health read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `inspectQueue` | `GET /gpt-access/queue/inspect` | DEFER | queue read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getSelfHealStatus` | `GET /gpt-access/self-heal/status` | DEFER | self-heal status read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `listCapabilitiesV1` | `GET /gpt-access/capabilities/v1` | DEFER | safe catalog read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getCapabilityV1` | `GET /gpt-access/capabilities/v1/{id}` | DEFER | one capability read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `runCapabilityV1` | `POST /gpt-access/capabilities/v1/{id}/run` | DEFER | allowlisted execution; possible writes/jobs. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `listGptAccessModulesAlias` | `GET /gpt-access/modules` | DEFER | safe catalog alias read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getGptAccessModuleAlias` | `GET /gpt-access/modules/{id}` | DEFER | one capability alias read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `createAiJob` | `POST /gpt-access/jobs/create` | DEFER | durable AI job; worker/provider generation. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getJobResult` | `POST /gpt-access/jobs/result` | DEFER | protected job read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `queryJobEventTimeline` | `POST /gpt-access/jobs/timeline` | DEFER | sanitized job event read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `runDeepDiagnostics` | `POST /gpt-access/diagnostics/deep` | DEFER | approved runtime/database/worker/log/queue reads. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `explainApprovedQuery` | `POST /gpt-access/db/explain` | DEFER | approved SELECT-only EXPLAIN ANALYZE. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `queryBackendLogs` | `POST /gpt-access/logs/query` | DEFER | sanitized bounded log read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `arcanosMcpControl` | `POST /gpt-access/mcp` | DEFER | approved readonly control tool. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `runDispatch` | `POST /gpt-access/dispatch/run` | DEFER | operational planning; allowed effects; possible provider/jobs. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |
| `getGptAccessOpenApi` | `GET /gpt-access/openapi.json` | DEFER | public contract read. Keep operator/device controls separate; conversational jobs need OAuth ownership adapter. |

### Shared bridge alternatives

| Operation ID | Method and endpoint | Disposition | Effects / migration reason |
| --- | --- | --- | --- |
| `invokeArcanosGptBridge` | `POST /api/bridge/gpt` | DEFER | durable GPT writing job; bounded wait. Legacy bridge retained; OAuth continuation needs ownership adapter. |
| `getArcanosBridgeHealth` | `GET /api/bridge/health` | DEFER | sanitized bridge/database/worker reads. Legacy bridge retained; OAuth continuation needs ownership adapter. |
| `getBridgeJobStatus` | `GET /jobs/{jobId}` | DEFER | public-provenance job status read. Legacy bridge retained; OAuth continuation needs ownership adapter. |
| `getBridgeJobResult` | `GET /jobs/{jobId}/result` | DEFER | public-provenance job result read. Legacy bridge retained; OAuth continuation needs ownership adapter. |
| `streamBridgeJobStatus` | `GET /jobs/{jobId}/stream` | DEFER | public-provenance job SSE read. Legacy bridge retained; OAuth continuation needs ownership adapter. |

### Backend action variants beneath the Actions

Booker `runBackstageBooker` covers `queryContinuity`, `generateBooking`,
`generateBookingWithHRC` and `simulateMatch`; all are DEFERRED. The separate
canon Action covers `upsertStoryline` and `appendCanonBeat`, both BLOCKED for
replacement pending approval/authority design. Operator-only `bookEvent`,
`updateRoster`, `trackStoryline` and `saveStoryline` are also BLOCKED for this
migration stage, even though the service implements them. Generation proposals
must never be represented as committed canon. Heavy generation creates a durable
job despite the legacy Action's non-consequential hint; MCP annotations must
reflect actual effects.

Core's module has one `query` action. Its gateway's conversational pair is
`createAiJob`/`getJobResult`; the remaining gateway operations are separately
privileged control, discovery or native-device lifecycle capabilities. The
canonical shared writing Action additionally admits typed `query_and_wait`
and selected `dag.capabilities`, `dag.dispatch`, `dag.status`, `dag.trace`
bridge variants; all are DEFERRED and excluded from the Tutor schema. Arbitrary
module/control actions remain prohibited. Job reads belong to their direct
boundaries, never prompt-shaped retrieval through `/gpt/:gptId`.

Gaming has only module `query`; canary, source ingest/refresh/status and three
hybrid operations are route-owned surfaces. A single module wrapper cannot
satisfy the migration. Preserve gameplay player-context precedence, conservative
spoiler policy, evidence coverage, source eligibility and response applicability.
Preserve `contractVersion`, `workflowId`, `idempotencyKey`, `discoveryType`,
`nextAction`, candidate IDs/decisions, `reviewedSources`, `requiredArticleUrl`,
currentness and applicability through every continuation. Do not retry with a
new key to obtain extra discovery rounds. `transient_only` never authorizes
storage; consent does not override source or actor policy.

Booker continuity must keep exact page/path/section or subtree scope,
snapshot-bound `nextCursor`, coverage/omitted-page/truncation fields and truthful
exhaustiveness. Protected failure, stale authority or transport abort cannot be
replaced by ChatGPT conversation, model memory, general knowledge, or direct
Notion reads. Existing managed polling carries verified client provenance,
owned job and unsealing semantics. Canon writes require a separate migration
stage: the old `x-openai-isConsequential` value is neither an MCP permission nor
proof of an enforced approval interaction.

## Follow-up PR scopes and exit criteria

### tutor-account-validation

Approved issuer/resource/scopes in isolated infrastructure, registered authenticated connection, private Builder/reference reconciliation and separate web/iOS/Desktop acceptance.

- Exact deployed SHA/transport.
- Real OAuth authorization.
- Real package connection reference.
- Separate installed-client behavior evidence.

### gaming-workflow-parity

Dedicated gameplay/canary/hybrid/source lifecycle wrappers reusing gamingHybridWorkflow and ingestion worker; no generic RAG replacement.

- All eight Actions.
- Preserve workflowId/idempotencyKey/contractVersion/discoveryType/nextAction/decisions/currentness/applicability.
- transient_only forbids writes; explicit independent storage consent.
- Bounded actor-isolated workflow and status.

### booker-read-generation

Exact-universe OAuth membership, registered provenance, continuity/generation/simulation, managed polling and bounded reads; preserve authority/quarantine.

- Current complete authority before generation.
- Snapshot/request-bound cursor and page version.
- Owned managed result unsealing.
- No conversation replacement after protected failure; no direct Notion bypass.

### booker-canon-separate

Later separately reviewed upsertStoryline/appendCanonBeat with supported client approval and server enforcement. Phase One operator mutations remain isolated.

- Per-client verified approval; old OpenAPI flag insufficient.
- Exact-universe membership.
- MutationId/expectedVersion/idempotency/unknown-outcome reconciliation.
- Notion authority remains read-only.

### core-conversation-ownership

Adapt existing jobs.create/jobs.result queue/gateway to OAuth owners, then establish session ownership before memory. Keep control/CLI/device surfaces separate.

- Cross-principal/session/job denial every state.
- Stable idempotency/replay.
- No operator or deployment-wide memory inheritance.
- Conversation contract parity.

## Evidence and remaining dependencies

| Evidence layer | Status in this inventory |
| --- | --- |
| Repository source and Action operation coverage | INSPECTED; 44 unique operations with source lines in manifest |
| Existing regression suites | Identified, not executed by inventory author; lead validation report owns actual run results |
| New Tutor implementation | Scoped pilot only; final tested head and commands recorded by lead |
| Deployed MCP transport and metadata | NOT VERIFIED by inventory |
| Real account OAuth authorization | NOT VERIFIED; approved provider/account configuration pending |
| Installed package behavior | NOT VERIFIED; registered connection reference pending |
| ChatGPT web | Intended; NOT VERIFIED |
| ChatGPT iOS | Intended; NOT VERIFIED |
| Desktop/Codex | Separate development packaging; installed behavior NOT VERIFIED |

Relevant existing suites include `tests/tutor-logic.prompt-forwarding.test.ts`,
`tests/gpt-session-context.integration.test.ts`,
`tests/gpt-session-context.e2e.test.ts`, `tests/mcp-job-tools.test.ts`,
`tests/mcp-route-isolation.test.ts`, `tests/gaming-hybrid-workflow.test.ts`,
`tests/gaming-source-http-boundary.test.ts`,
`tests/backstage-booker-async-continuation.test.ts`,
`tests/backstage-booker-gpt-client-auth.test.ts`,
`tests/gpt-access-gateway.test.ts` and the corresponding OpenAPI parity suites.
Their presence alone is not a passed test or production evidence.

External decisions still required: approved issuer and JWKS/resource/audience,
least-privilege grant policy, actual account/workspace eligibility, authenticated
integration registration and its real connection reference, private Builder and
reference reconciliation, and separately authorized isolated deployment/client
acceptance. An HTTPS MCP URL alone establishes none of the account or web/iOS
installation claims. Release packaging must stay blocked when its connection
reference is unresolved. Do not put tokens, account IDs or private exports into
this inventory to satisfy that gate.

Disabling the new integration leaves the existing GPT Actions, dedicated
credentials, operator MCP and backend services in place. No live GPT was edited,
no knowledge or universe content migrated, and this inventory author performed
no deployment, account connection, install, or production persistence test.
