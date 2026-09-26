# ARCANOS TUTOR migration handoff

Evidence date: **2026-09-26 UTC**. Current main:
`71672aec22d7babf62d65b96de667f17abd3f219` (merged PR #1513).
PR #1509 remains the **DRAFT migration container**, with auto-merge disabled.
**BACKEND_PLANE=FAIL**, **LIVE_TUTOR_CALL_VERIFIED=BLOCKED**.
**GPT_MIGRATED=VERIFIED**. Owner-authorized private account migration completed
on September 26. **SKILL_PLANE=BLOCKED_MATERIAL_INTEGRATION_DIFFERENCES**:
the generated skill preserves the published instructions but lacks the separately
approved integration safeguards. See the [actual artifact review](TUTOR_POST_MIGRATION_RECONCILIATION_20260926.md).
The [pre-migration checkpoint](TUTOR_PRE_MIGRATION_CHECKPOINT_20260926.md) is historical.

The owner has selected **skill-first tutoring with an optional ARCANOS app**.
The current package is a public source template; approved private instructions
are composed only beneath the ignored local input directory. See the
[skill-first implementation](TUTOR_SKILL_FIRST_20260925.md) and
[current platform evidence](TUTOR_SKILL_FIRST_PLATFORM_20260925.md).
Ordinary tutoring does not require a backend connection. Teaching readiness and
backend acceptance are separate; neither certifies the other.

Current main is authoritative for runtime code, schemas, tests, preview fixtures
and production documentation. It was merged non-destructively into #1509 from
`68bd5eeebf63f637ccd743110d81da5cce1b1991`. Only `backend-index.json` and
`docs/BACKEND_INDEX.md` conflicted. All four indexes were regenerated; their content
matched main except timestamps, so main's exact generated versions were retained
and `reindex:check` passed. Runtime and preview paths have no remaining diff from
main. Migration/package tooling, private-input guards and evidence remain here.

[PR #1511](https://github.com/pbjustin/Arcanos/pull/1511) and
[PR #1512](https://github.com/pbjustin/Arcanos/pull/1512) were merged and deployed
historically. [PR #1513](https://github.com/pbjustin/Arcanos/pull/1513) adds sealed
honesty-composition verification, not a runtime behavior fix or live acceptance.
Read-only provider metadata at **2026-09-26T01:55:51Z** confirmed current worker
`e08d2468-a287-4d5c-aa1b-f3b8aaf7d0b2` and web
`a994758c-bc6a-4d4e-a8dc-fd4e66cb5f1e` as latest **SUCCESS**, with main's SHA in
both metadata records. No deployment or production configuration change occurred.
Provider commit metadata is not container attestation.

The September 26 final bounded attempt window followed supported existing Primary
reconnection and Refresh. Raw A/C/D each returned TUTOR_UNAVAILABLE with connector
INVALID_ARGUMENT. ChatGPT A produced one activity entry and no final result; C
produced two ambiguous activity entries and an unavailable error; D was not
submitted to protect the six-invocation ceiling. Five test requests were submitted,
with six conservatively counted potential invocations, not six confirmed calls.
Same-invocation raw ChatGPT payloads and internal retry counts remain unavailable.
No fresh honesty-transform cause or successful backend acceptance is established.
Durable renewal remains unverified; no further calls are authorized by this task.
The post-#1512 formatting failures below remain historical evidence.

The complete private published configuration validates and repeated captures
produce the same baseline fingerprint. The owner confirmed zero published
starters/knowledge and Action authentication None, then approved the complete
transcription and seven expected-behavior summaries. Review is recorded as Owner
(task confirmation), 2026-09-25T20:00:43Z. GPT_BASELINE_CAPTURED is VERIFIED and
latestPublishedConfirmed is true; publication assurance remains USER_REPORTED,
distinct from independent source/hash verification. See the
[baseline capture checkpoint](TUTOR_BASELINE_CAPTURE_20260925.md).
There are **16 parity cases: 0 baseline-bound, 10 provisional/unbound and 6
unexecuted**. All official old-GPT and plugin result fields remain null. Published
knowledge is explicitly confirmed empty; the complete installed bundle now confirms
zero migrated reference files and an explicitly empty knowledge index. Account
migration occurred, but no teaching test or backend call ran during artifact reconciliation.
See the [current reconciliation record](TUTOR_RECONCILIATION_20260925.md),
[private input contract](TUTOR_INPUTS.md), and the dated historical evidence below.

## What is ready, and what is not

The [standalone package](../../integrations/arcanos-tutor/README.md) has the final
ARCANOS TUTOR identity and a real optional app mapping. Its tracked skill is a
public template with integration safeguards, not the private teaching release.
The deterministic private composition preserves the approved instruction text;
the owner approved the unchanged exact artifact on 2026-09-26T01:03:47Z.
Its installed teaching behavior remains unverified.
The [gate ledger](../../integrations/arcanos-tutor/migration-state.json) records
independent states; there is no single migrated boolean.

| Gate | Current status | Basis |
| --- | --- | --- |
| CODE_READY | VERIFIED | Repository migration/package scope only; current reconciliation validation is recorded in TUTOR_RECONCILIATION_20260925.md. Live runtime acceptance remains failed. |
| BACKEND_DEPLOYED | VERIFIED | Current main 71672aec; exact current worker/web IDs above are latest SUCCESS in the 2026-09-26 provider metadata recheck |
| OAUTH_CONFIGURED | VERIFIED | Fresh existing Primary recovery and Refresh; exact-client renewal durability remains unverified |
| CHATGPT_CONNECTION_REGISTERED | VERIFIED | September 26 UI matched the same expected resource and app identity; no replacement connection |
| TOOL_DISCOVERY_VERIFIED | VERIFIED | Fresh Refresh exposed one tool; current connector prompt contract and public scope verified; full refreshed schema not exposed |
| LIVE_TUTOR_CALL_VERIFIED | BLOCKED | Fresh raw A/C/D unavailable; ChatGPT A incomplete, C unavailable, D stopped before budget ceiling |
| GPT_BASELINE_CAPTURED | VERIFIED | Complete private capture, deterministic fingerprint and owner review recorded; latestPublishedConfirmed=true |
| TUTOR_SKILL_COMPOSED | VERIFIED | Local composition integrity only; v3/v4 bytes match |
| TUTOR_SKILL_RECONCILED | VERIFIED | Owner approved unchanged private skill 7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096; exact baseline/package bindings and source integrity rechecked |
| TUTOR_SKILL_BEHAVIOR_VERIFIED | BLOCKED | Eighteen cases unexecuted; supported composer now exists, but safeguards must be reconciled before safe formal testing |
| CAPABILITY_EQUIVALENCE_VERIFIED | NOT_APPLICABLE | Owner excludes the four host ChatGPT features from Tutor release scope; their equivalence remains NOT_TESTED |
| BACKEND_APP_REGISTERED | VERIFIED | Fresh unchanged existing app identity; no new connection |
| BACKEND_APP_OPTIONALITY_VERIFIED | VERIFIED | Official optional syntax and offline reference contract only; installed behavior unverified |
| MIGRATED_SKILL_RECONCILED | BLOCKED | Actual skill captured; five approved integration sections absent |
| GPT_MIGRATED | VERIFIED | Owner-authorized private migration confirmed; native installed artifacts hashed |
| SKILL_RECONCILED | BLOCKED | Published instruction bytes preserved; approved composed safeguards not present |
| REFERENCES_RECONCILED | VERIFIED | Complete native bundle matches the published zero-file knowledge inventory |
| PARITY_VERIFIED | BLOCKED | Actual paired old/new results absent; no provisional observations promoted |
| PACKAGE_READY | BLOCKED | Actual native capture inspected; integration safeguards, behavior and paired parity remain unresolved |
| RELEASE_READY | BLOCKED | Draft only; no replacement release or retirement |

Allowed statuses are VERIFIED, USER_REPORTED, IMPLEMENTED_NOT_VERIFIED, BLOCKED
and NOT_STARTED. Only CAPABILITY_EQUIVALENCE_VERIFIED additionally permits
NOT_APPLICABLE, with the exact four-feature owner scope decision and baseline-bound
evidence required by [the input contract](TUTOR_INPUTS.md#host-capability-release-scope).
Only TUTOR_SKILL_BEHAVIOR_VERIFIED additionally permits DEFERRED_POST_MIGRATION
with exact approved-artifact and execution-surface binding; this never satisfies
release dependencies. These exceptions are not verified behavior or a general gate bypass.
VERIFIED always identifies its evidence domain. A successful
local test cannot verify account migration; user reports cannot become independent
account evidence merely by changing a label.
Historical observations remain in the evidence ledger, while the gates describe
the current candidate. Deployment, refreshed discovery and model execution are
separate from successful runtime acceptance and migrated-plugin parity. The
manual pre-migration owner-decision checkpoint below is distinct from these twenty
machine-readable release gates.

## Historical evidence provenance (2026-09-24)

[connection.requirements.json](../../integrations/arcanos-tutor/connection.requirements.json)
contains only non-secret metadata and sanitized summaries:

- Repository: the reviewed package candidate and preview used exact head
  `7f4e8c6de2ad145be04de23a436a2dc106f118e7`. Subsequent scoped Tutor repairs
  address a false positive for learner-directed mathematical verification and a
  connector-side nonempty-prompt schema mismatch. A separate reviewer found no
  code blocker in the repair diff. Local validation and the earlier tracked
  evidence review passed. Those repairs subsequently merged and deployed through
  #1510; independent review of the current reconciliation, hashes and evidence
  found no publication blocker, while runtime acceptance remains failed.
- Historical Railway production observation, before the #1510 rollout: the
  earlier read-only check identified deployment
  `e14cfd48-0075-4996-b0dd-ec7b620d5d82` as SUCCESS at the base SHA.
  Inspected configuration names only:
  `CHATGPT_MCP_ENABLED`, `CHATGPT_MCP_RESOURCE`, `CHATGPT_MCP_ISSUER`,
  `CHATGPT_MCP_JWKS_URL`, and presence of `OPENAI_API_KEY`.
- Public HTTP: protected-resource metadata returned the exact
  `https://acranos-production.up.railway.app/chatgpt/mcp` resource, Auth0 issuer
  `https://dev-etfsljoipfurdij6.us.auth0.com/`, and only `arcanos:tutor`.
  At `2026-09-24T04:29:23.768Z`, metadata returned 200 and anonymous MCP access
  returned 401. The earlier readiness observation was healthy. These are public
  endpoint observations, not authenticated discovery or execution.
- Earlier authorized work in this same task: Auth0 policy configuration,
  completed OAuth linking, ChatGPT connection Refresh and the expanded real
  tool result were observed through the supported UI. The safe setup audit and
  task history support these dated observations.
- Historical connection observation on 2026-09-24 before the rollout: an initial
  concise attempt returned `UNAUTHORIZED` and the
  UI showed **Reconnect**. At approximately 04:32 UTC, supported same-account
  Reconnect completed and Refresh showed exactly `arcanos_tutor`, the expected
  resource, OAuth, raw app ID and technical ID. No new registration or scope was
  introduced. A subsequent direct attempt returned connector `INVALID_ARGUMENT`
  before backend execution because of the prompt schema pattern. It produced no
  Tutor answer. This pre-deployment schema failure is superseded by the deployed
  schema, fresh Primary authentication, explicit Refresh and raw model results
  recorded in [runtime acceptance](TUTOR_RUNTIME_ACCEPTANCE.md). It does not
  explain away the current response-quality failures.
- Current original-GPT observation: Builder showed **Live**, **Only me** and a
  displayed current version date of **Mar 5, 2026**. That date is not treated as
  an exact latest-publication timestamp. Owner confirmation of publication and
  completeness, the complete knowledge inventory and a reviewed local
  `published-gpt.json` are still missing.
- User-reported account state: original GPT remains unchanged and unmigrated.
  The user also reported connection/OAuth/live-call success, which is recorded
  separately from the prior observed evidence.

The earlier pre-rollout live call asked for a two-sentence explanation of equivalent fractions. It
returned a mathematically relevant answer with an unnecessary live-access
disclaimer, totaling three sentences. Tool metadata was `generation: model`,
`module: ARCANOS:TUTOR`, `execution: synchronous`, `memory: unavailable`.
That is live execution proof, not an original-GPT comparison or proof of the
new packaged skill. No full private conversation or private chat URL is committed.
The formatting issue is a blocker to investigate, not an accepted difference.

One fresh, provisional original-GPT concise probe produced two sentences, no
irrelevant live-access disclaimer, no visible Action invocation and no diagnostic
claim; it correctly described equal amounts and splitting a half into quarters.
This observation is not bound to a complete published-configuration fingerprint.
It therefore does not populate an official `oldGpt` parity result or resolve the
original-versus-migrated comparison. No migrated skill or migrated result exists.

Ten old-GPT cases have now been observed provisionally, with **0/16 official
fingerprint-bound results**. No Action invocation was visible in those ten cases.
The exact-format case produced one ordered list with three items; several other
cases used diagnostic framing. These are observations, not case passes or parity.
Safe local summaries, prompt/summary hashes and timestamps are retained only in
the ignored private review record; no raw transcript enters tracked files.
Six cases remain unobserved: administration, authentication failure, unavailable
backend, timeout, cancellation and reference use. The first five need controlled
nonexecuting account fixtures; reference use also awaits the complete inventory.
All official `oldGpt` and `plugin` fields remain null and all sixteen rows remain
`BLOCKER`.

The [backend review](TUTOR_BACKEND_REVIEW.md) records the dated pre-split repair
evidence: that earlier focused selection passed thirteen suites / 407 tests, and the separate
protocol selection passed four suites / 55 tests. Together these nonoverlapping
selections passed 462 tests with no failures or skips. Type-check, build, lint and
backend/CLI contract/offline checks passed; lint retains 76 existing warnings.
Type-check/build initially lacked a generated Prisma client after script-free
dependency installation and passed after local generation. Four MCP SDK prompt
cases cover the schema fix, with zero acceptance differences in an independent
3,379-string comparison. Source package validation passed; release validation
correctly exited 2 with `RELEASE_BLOCKED` and no archive. Sync check reported zero
errors, zero warnings and five informational notices.

The old-guard negative control corrupted a synthetic two-sentence answer; its
selected regression failed with 11 other cases intentionally skipped. That result
and the repaired initial four-suite / 118-test pass demonstrate a narrow code-level
cause, not complete attribution of the historical live response. The 118 tests
are covered by that later focused selection and are not added again. The current
post-deployment raw results still fail runtime acceptance; no migration or parity
gate is promoted. The new runtime report separates this current evidence from
the earlier `LIVE_RETEST_PENDING` state.

## Sealed preview evidence at the earlier exact head

The temporary preview was verified on 2026-09-24 and removed. This evidence covers
only `7f4e8c6de2ad145be04de23a436a2dc106f118e7`, with trusted workflow/verifier
`3f9fffe48219b784dca758bca87ade109324c7c9`; it does not cover the subsequent
repairs or promote any migration, reconciliation or parity gate.

| Evidence | Result |
| --- | --- |
| [Hosted lifecycle and E2E](https://github.com/pbjustin/Arcanos/actions/runs/35953275709) | PASS, executed 156/156 requests |
| Independent clean exact-head verifier | PASS, executed 156/156 requests against the same confirmed hosts |
| Actual MCP SDK 1.30.0 | PASS, six requests / 2,438 response bytes / 481 ms; synthetic Tutor result |
| [Cleanup](https://github.com/pbjustin/Arcanos/actions/runs/35954007244) | PASS; owned environment absent in provider inventory and both former hosts returned 404 |

Both full verifiers passed all 18 Tutor cases with `chatgpt-tutor-mock/v1` proof.
The SDK observed readiness, initialize, initialized notification, optional GET
rejection, single-tool discovery and tools/call. Its response explicitly reported
`generation: mock`, `module: ARCANOS:TUTOR`, synchronous execution and unavailable
memory. The worker was passive. Hosted and independent runs each observed 133,663
response bytes; the broad verifier used 24 simulated-authentication requests.

The source report is the task-local `PR1509_PREVIEW_PROOF.md`, retained with the
full JSON proofs outside the checkout. Its final non-draft snapshot describes the
completed preview task; this migration task subsequently restored draft status.
No fixture change was needed for that exact-head preview. The new repairs require
their own validation.

This is credential-free served component and SDK evidence. It does not establish
real OAuth sign-in, a live model answer, an active queue or worker, database
behavior, an installed migrated skill, mobile behavior or teaching parity.

## Historical pre-migration checkpoint

**READY_FOR_OWNER_DECISION_WITH_BACKEND_DEGRADED**. The approved baseline and
exact owner-approved composed skill remain unchanged. Official desktop development
testing exists but cannot be used inside this task's exclusive private-input
boundary or available web-only control. All eighteen actual teaching cases are
formally deferred, with no synthetic substitute or claimed pass.

The optional backend failed the final bounded attempt window. The owner may now
decide whether to migrate with that backend explicitly unavailable/degraded.
There is no new pre-migration engineering requirement from this evidence. Actual
migration, installed-skill testing, generated references, and paired parity are
post-migration work, not missing prerequisites for presenting this decision.
The sixteen old-GPT parity rows remain 0 bound / 10 provisional / 6 unexecuted.

The [final checkpoint](TUTOR_PRE_MIGRATION_CHECKPOINT_20260926.md) records the exact
artifact hashes, call budget limits, official surface evidence, and thirteen-item
post-migration checklist. The PR stays draft, release stays blocked, and a separate
explicit migration decision is still required. No migration action is authorized
by this document.

## Before migration: capture the published baseline

This baseline procedure is already completed for the current candidate.

1. In the owner's actual **My GPTs** controls, inspect ARCANOS TUTOR. Confirm its
   exact display name and latest published version/date. Publishing edits requires
   separate owner authorization; capture the actual published version. An unpublished
   draft or repository prompt is not the baseline.
2. Privately save the published description, full Builder instructions,
   conversation starters, enabled capabilities, Action names and complete schemas,
   sharing status and representative expected behavior. If a formal export is
   unavailable, make an owner-reviewed local transcription and explicitly record
   its provenance and completeness; do not label repository text a Builder export.
3. Obtain the complete published knowledge inventory. Preserve exact names,
   original bytes, byte sizes and SHA-256 when files are supplied. Distinguish
   unknown from a confirmed zero-file inventory. Never infer missing file contents.
4. Store inputs in ignored `.local-migration/arcanos-tutor/`. Only safe reviewed
   names, hashes, sizes, provenance, statuses and sanitized prompt definitions may
   enter tracked inventories. Do not commit private Builder text, knowledge, raw
   transcripts, credentials or session material. Filename metadata can itself be
   sensitive; review it before copying it into the public inventory.
5. Preserve existing old-GPT observations in the
   [parity matrix](../../integrations/arcanos-tutor/parity-matrix.json). Any later
   old-GPT execution needs separate authorization; unbound observations do not
   block presenting the current owner decision. Record sanitized summaries plus hashes of local result artifacts.
   Keep the full source privately. The sixteen definitions cover direct/indirect
   activation, non-activation, clarification, concise explanation, structured
   lesson, learner follow-up, difficult questions, exact format, memory/admin
   refusal, authentication, unavailable backend, timeout, cancellation and
   references.

The baseline gate requires the actual latest published data and complete
inventory to be supplied, checked and owner-reviewed. The current baseline
satisfies those requirements; this preparation guide alone is not evidence.

The [private input contract](TUTOR_INPUTS.md) gives the exact capture command,
required local fields, sanitized-output review and release-validation command.

## Historical migration authorization checkpoint

The owner subsequently authorized and completed migration; do not repeat it.
The requirements below describe the earlier checkpoint. A later owner decision had to
explicitly cover migration with the optional backend degraded and acknowledge
the consequences below. Reconfirm current account eligibility at that time:

- Essential changes are published and the complete published baseline is captured.
- The existing app identity and single-tool boundary remain as documented. Its
  failed acceptance must be disclosed; backend health is not a technical
  prerequisite for the skill-first migration decision.
- The package mapping matches that real connection, and the account actually offers
  migration. A prior web tool call does not prove migration eligibility.
- The approved baseline is preserved, historical observations remain accurately
  unbound, and deferred real-plugin tests and rollback limits below are understood.
- The owner understands the original GPT becomes read-only; custom Actions,
  conversations, selected model and sharing settings do not transfer.
- The replacement starts private; installation must be observed separately from
  sharing. This account subsequently showed the plugin installed; no sharing occurred. Custom Action behavior must be replaced by the scoped registered
  Tutor tool and then tested.

Once these conditions hold, the exact handoff is **My GPTs → ARCANOS TUTOR →
Migrate to plugin**. Request a separate explicit user confirmation immediately
before invoking an available in-product migration action. Authorization to create
this PR, configure OAuth earlier, or reuse the provider key is not authorization
to click it. Never simulate the account action or infer its output.

## After the user performs migration

Accept only the actual generated skill text, reference inventory/files, plugin
metadata and all migration warnings. Keep those artifacts privately first.

1. Compare every instruction block to the captured published Builder instructions:
   record omissions, duplication, material edits and ordering changes that affect
   behavior. Preserve intentional teaching style; make any proposed difference
   explicit for owner review.
2. Compare published knowledge to actual migrated references using exact names,
   sizes and hashes. Record missing, added, renamed, truncated or unsupported
   files. An unexplained difference is a blocker.
3. Separate migrated teaching instructions from repository-required integration
   safeguards. The backend remains responsible for authorization. Do not turn a
   skill instruction into new backend permission or invent saved learning progress.
4. Inspect the actual generated format. This native migration contains skills only
   and no app mapping; record NOT_ATTACHED without inventing an app file. The
   separately composed portable candidate retains its reviewed optional mapping.
   Validate each format explicitly and preserve the existing connection unchanged.
5. Approve each exact reference file for repository publication before copying it.
   Local possession, migration, or metadata review is not content-publication
   permission. If required private content cannot be committed, keep public
   release blocked and arrange a separately authorized private distribution path.
6. Re-run the parity cases in a new chat with the actual migrated skill installed
   and the intended app attached. Bind results to the reviewed skill/reference
   hashes and record the invoked tool. A direct MCP call alone is insufficient.

Use connection **Refresh** after MCP catalog changes, then inspect discovery.
MCP-imported skills require a new scan; submitted versions require a new reviewed
version; local packages require refreshing their installed copy/restarting the
desktop client. Follow the [current platform reconciliation](TUTOR_PLATFORM_RECONCILIATION.md)
for the applicable surface. This checkpoint performed only the authorized existing
Primary reconnect and metadata Refresh; it did not install or scan a teaching skill.

## Parity disposition and release

For each row record prompt, old-GPT summary, migrated-plugin summary, tool invoked,
material difference and PASS, ACCEPTED_DIFFERENCE or BLOCKER. An accepted difference
needs explicit owner identity/date and rationale, the exact case/prompt binding,
and both baseline and candidate fingerprints; it is never inferred from the
narrowed backend scope. No differences have been accepted at this stage.

Failure-path tests use isolated fixtures or separately authorized account tests;
never break production configuration to exercise them. If there are no reference
files, verify both empty inventories and record a reviewed not-applicable result
for the reference case. Missing inventory is not not-applicable.

The package validator requires actual local artifact hashes, complete inventories,
reviewed reference approval and completed parity evidence before release success.
Its synthetic success fixture is labelled as a fixture and is not copied into
the real migration inventory. Preserve the old route until explicit retirement
approval. Keep this PR draft until skill/reference reconciliation and parity
blockers are resolved; readiness or merge is never automatic.

## Production impact and rollback

Supported migration made the original ARCANOS TUTOR Custom GPT read-only.
No separate edit, deletion or retirement of its historical Actions was performed. Gaming, Booker and Core are outside
this PR. No production variable or credential change was made **as part of this
PR**; earlier separately authorized OAuth activation is dated evidence only.
The scoped preview deployment was removed. The subsequent separately authorized
#1510, #1511 and #1512 runtime rollouts are historical. Current main and the
current deployment pair are recorded at the top; runtime acceptance remains failed. That code
rollout did not perform account migration, replacement sharing or installation.
The package does not add memory, profiles, persistence, ingestion or admin tools.

Before migration, abandoning the branch/package leaves the existing GPT and
registered app intact. Reverting repository changes cannot reverse a completed
account migration or restore GPT editability. After migration, the old GPT remains
usable only for the platform's remaining availability; its conversations are
not moved to the replacement. Retain the private baseline and avoid retiring any
route while parity is unresolved. A production rollback or retirement would
require its own explicit authorization; neither is carried out by this task.

## Historical handoff opening (2026-09-24, superseded current-state wording)

The following original checkpoint is retained as history. Its uses of current or
fresh refer to September 24 and do not supersede the September 26 status above.

Evidence date: **2026-09-24 UTC**. Current main:
`8af7a5712ebd5954a97af06ab31d0e2527ac0b58` (PR #1510 merge).
This document prepares account-side work; it does not authorize the irreversible
migration. Keep the PR draft until actual migrated skill/reference reconciliation
and parity pass.

The runtime repairs were merged through
[PR #1510](https://github.com/pbjustin/Arcanos/pull/1510) at the current main SHA
above. Its approved head `3bf9edc010f8e1680783d6fcd19ba990d88894ad` was extracted
from this PR's reviewed `aeb38692221082a41f6e4382bb8b651c24c917ca` onto the
earlier `3f9fffe48219b784dca758bca87ade109324c7c9` base. The split contained
the prompt-schema and isolated Tutor arithmetic-honesty repairs, necessary
regressions and documentation/index updates. Published GPT exports, knowledge
files and migrated-plugin parity remain separate migration requirements.

The separately authorized code rollout deployed worker
`628f094e-4fee-4523-8eb0-2dc145364e96` and web
`4d3576b6-8f45-421e-ba6d-23b9f01f079d`. A fresh read-only recheck at
**2026-09-24T17:51:14Z** passed: both expected deployments were sole active
`SUCCESS` and ready, with no observed configuration drift. This deployment
evidence does not establish Tutor response acceptance.

The [candidate acceptance checkpoint](TUTOR_CANDIDATE_ACCEPTANCE.md) retains the
earlier non-production discovery and pending isolated-target proposal as dated
evidence. At that earlier discovery stage, no approved authenticated isolated
candidate target was found or deployed. The subsequent production rollout and
current results are recorded in [runtime acceptance](TUTOR_RUNTIME_ACCEPTANCE.md).
Existing **Primary** authentication and an explicit connection **Refresh**
succeeded, exposing the corrected prompt schema. All four raw A–D results used
`generation: model`, but only B passed. A, C and D included a canned live-access
disclaimer; C omitted cross-multiplication and D used flat numbering.
Raw results total **1 pass and 3 failures**. ChatGPT displayed results also total
**1 pass and 3 failures**: A returned an authentication error, B passed display
requirements, and C/D failed format/content requirements. Same-invocation raw
payloads were unavailable, leaving **0/4 fully evidenced raw/final paired
ChatGPT passes**. **RUNTIME_ACCEPTANCE = FAIL** and
`LIVE_TUTOR_CALL_VERIFIED` stays `BLOCKED` because the repeated raw defect
violates the required absence of a systematic response defect.

Keep #1509 draft. Current main has been merged into its local review checkout
using the non-destructive workflow in
[the synchronization skill](../../.agents/skills/arcanos-safe-worktree-sync/SKILL.md).
Unrelated worktrees and ignored local inputs were preserved. Only the four generated indexes
conflicted, and regeneration resolved them. All nine runtime/schema/test repair
paths and the schema guide match main in the index and working tree, so those
repairs are absent from the remaining diff. Packaging, published
baseline capture, migrated instructions/references and paired parity remain in
#1509. Migration gates are unchanged; baseline-bound old-GPT results remain
0/16 and the account migration still requires separate owner confirmation.
