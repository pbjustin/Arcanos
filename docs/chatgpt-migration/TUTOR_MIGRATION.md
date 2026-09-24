# ARCANOS TUTOR migration handoff

Evidence date: **2026-09-24 UTC**. Base main:
`3f9fffe48219b784dca758bca87ade109324c7c9` (PR #1508).
This document prepares account-side work; it does not authorize the irreversible
migration. Keep the PR draft until actual migrated skill/reference reconciliation
and parity pass.

## What is ready, and what is not

The [standalone package](../../integrations/arcanos-tutor/README.md) has the final
ARCANOS TUTOR identity and a real required app mapping. Its skill is a reviewed
repository integration candidate, not a reconstruction of published Builder text.
The [gate ledger](../../integrations/arcanos-tutor/migration-state.json) records
thirteen independent states; there is no single migrated boolean.

| Gate | Current status | Basis |
| --- | --- | --- |
| CODE_READY | VERIFIED | Scoped repairs and final tracked evidence independently reviewed without repository blockers; local validation below |
| BACKEND_DEPLOYED | IMPLEMENTED_NOT_VERIFIED | Current backend/schema repairs are not deployed; earlier Railway SUCCESS is historical evidence |
| OAUTH_CONFIGURED | VERIFIED | Same-account Reconnect completed; fresh UI showed OAuth |
| CHATGPT_CONNECTION_REGISTERED | VERIFIED | Fresh UI matched the expected resource, raw app ID and technical ID |
| TOOL_DISCOVERY_VERIFIED | VERIFIED | Fresh Refresh showed exactly arcanos_tutor |
| LIVE_TUTOR_CALL_VERIFIED | BLOCKED | Current call blocked before backend by connector schema validation; historical model result retained separately |
| GPT_BASELINE_CAPTURED | BLOCKED | Latest published configuration and knowledge inventory missing |
| GPT_MIGRATED | NOT_STARTED | Migration click has not been authorized or performed |
| SKILL_RECONCILED | BLOCKED | Actual migrated skill and published instructions missing |
| REFERENCES_RECONCILED | BLOCKED | Actual published and migrated file inventories missing |
| PARITY_VERIFIED | BLOCKED | Old/new paired results absent; live formatting issue unresolved |
| PACKAGE_READY | BLOCKED | Actual artifact inspection and parity still required |
| RELEASE_READY | BLOCKED | Draft only; no replacement release or retirement |

Allowed statuses are VERIFIED, USER_REPORTED, IMPLEMENTED_NOT_VERIFIED, BLOCKED
and NOT_STARTED. VERIFIED always identifies its evidence domain. A successful
local test cannot verify account migration; user reports cannot become independent
account evidence merely by changing a label.
Historical observations remain in the evidence ledger, while the gates describe
the current candidate. Fresh connection observations do not certify live execution
or deployment of the repairs. The pre-migration checkpoint below remains false
independently of these thirteen machine-readable gates.

## Evidence provenance

[connection.requirements.json](../../integrations/arcanos-tutor/connection.requirements.json)
contains only non-secret metadata and sanitized summaries:

- Repository: the reviewed package candidate and preview used exact head
  `7f4e8c6de2ad145be04de23a436a2dc106f118e7`. Subsequent scoped Tutor repairs
  address a false positive for learner-directed mathematical verification and a
  connector-side nonempty-prompt schema mismatch. A separate reviewer found no
  code blocker in the repair diff. Local validation passed; final tracked evidence
  review also found no repository blocker. The repairs have not been deployed.
- Railway production: the earlier read-only observation identified deployment
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
- Current connection: an initial concise attempt returned `UNAUTHORIZED` and the
  UI showed **Reconnect**. At approximately 04:32 UTC, supported same-account
  Reconnect completed and Refresh showed exactly `arcanos_tutor`, the expected
  resource, OAuth, raw app ID and technical ID. No new registration or scope was
  introduced. A subsequent direct attempt returned connector `INVALID_ARGUMENT`
  before backend execution because of the prompt schema pattern. It produced no
  Tutor answer. Fresh live execution and formatting remain `LIVE_RETEST_PENDING`
  until the schema repair is deployed, the catalog refreshed and an actual call
  succeeds; production deployment is not authorized by this task.
- Current original-GPT observation: Builder showed **Live**, **Only me** and a
  displayed current version date of **Mar 5, 2026**. That date is not treated as
  an exact latest-publication timestamp. Owner confirmation of publication and
  completeness, the complete knowledge inventory and a reviewed local
  `published-gpt.json` are still missing.
- User-reported account state: original GPT remains unchanged and unmigrated.
  The user also reported connection/OAuth/live-call success, which is recorded
  separately from the prior observed evidence.

The live call asked for a two-sentence explanation of equivalent fractions. It
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

The [backend review](TUTOR_BACKEND_REVIEW.md) records the scoped repair evidence:
the final focused selection passed thirteen suites / 407 tests, and the separate
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
are covered by the later focused selection and are not added again. The live
formatting issue remains `LIVE_RETEST_PENDING`; no migration or parity gate is
promoted.

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

## Pre-migration checkpoint

**MIGRATION_CHECKPOINT_READY = false.** This is a manual checkpoint, not an
additional machine-readable gate. The PR is draft and the preview opt-in label
is absent. Before requesting the separate migration-click confirmation, require:

- Owner-confirmed latest published version and complete baseline, including the
  complete knowledge inventory and publication provenance.
- All applicable old-GPT cases bound to that baseline; provisional observations
  alone are insufficient.
- Fresh authenticated connection, exact real app mapping and single-tool catalog.
- Reviewed migration consequences and rollback limits.
- Resolution of the live formatting issue, or explicit owner acceptance bound to
  the exact case and baseline and candidate fingerprints.

Latest-publication/completeness confirmation, complete bound baseline results and
live retesting of the repairs remain pending. The connection/catalog refresh alone
does not satisfy these conditions. No migration action, reference publication or
replacement installation is authorized by this checkpoint document.

## Before migration: capture the published baseline

1. In the owner's actual **My GPTs** controls, inspect ARCANOS TUTOR. Confirm its
   exact display name and latest published version/date. Publish essential
   pending edits yourself, then capture that published version. An unpublished
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
5. Run the old GPT against every applicable row in the
   [parity matrix](../../integrations/arcanos-tutor/parity-matrix.json) while it is
   available. Record sanitized summaries plus hashes of local result artifacts.
   Keep the full source privately. The sixteen definitions cover direct/indirect
   activation, non-activation, clarification, concise explanation, structured
   lesson, learner follow-up, difficult questions, exact format, memory/admin
   refusal, authentication, unavailable backend, timeout, cancellation and
   references.

Baseline remains BLOCKED until the actual latest published data and complete
inventory are supplied and checked. Independent repository work can finish now.
Do not check off the gate from this preparation guide.

The [private input contract](TUTOR_INPUTS.md) gives the exact capture command,
required local fields, sanitized-output review and release-validation command.

## The irreversible checkpoint

**Do not press Migrate to plugin yet.** Immediately before that click, prove all
of the following against actual account and local evidence:

- Essential changes are published and the complete published baseline is captured.
- The existing approved account can authenticate; a fresh connection inspection
  still points to the intended resource and exposes exactly `arcanos_tutor`.
- The package mapping matches that real connection, and the account actually offers
  migration. A prior web tool call does not prove migration eligibility.
- Baseline regression results are captured, and rollback limits below are understood.
- The owner understands the original GPT becomes read-only; custom Actions,
  conversations, selected model and sharing settings do not transfer.
- The replacement starts private; migration does not automatically install or
  share it. Custom Action behavior must be replaced by the scoped registered
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
4. Confirm generated metadata and the final package use the actual registered
   app, and that normal Tutor behavior no longer needs a legacy Custom Action.
   Inventory the actual app-mapping file selected by the migrated manifest as
   `appMapping`; release validation checks its path, hash, byte size and required
   Tutor app identity instead of relying only on the reviewed app-ID assertion.
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
for the applicable surface. This PR performs none of those account changes.

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

Existing ARCANOS TUTOR Custom GPT remains operational until retirement.
Existing Custom GPT Actions remain unchanged. Gaming, Booker and Core are outside
this PR. No production variable or credential change was made **as part of this
PR**; earlier separately authorized OAuth activation is dated evidence only.
The scoped preview deployment was removed; no production deployment, key rotation,
account migration, sharing or installation has occurred. The subsequent backend
repairs have not been deployed.
The package does not add memory, profiles, persistence, ingestion or admin tools.

Before migration, abandoning the branch/package leaves the existing GPT and
registered app intact. Reverting repository changes cannot reverse a completed
account migration or restore GPT editability. After migration, the old GPT remains
usable only for the platform's remaining availability; its conversations are
not moved to the replacement. Retain the private baseline and avoid retiring any
route while parity is unresolved. A production rollback or retirement would
require its own explicit authorization; neither is carried out by this task.
