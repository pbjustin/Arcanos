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
| CODE_READY | VERIFIED | Type/build/lint, 264 focused tests and independent review; full repository CI reported separately |
| BACKEND_DEPLOYED | VERIFIED | Railway SUCCESS at the expected PR #1508 merge |
| OAUTH_CONFIGURED | VERIFIED | Prior same-task Auth0 setup observed; public challenge rechecked |
| CHATGPT_CONNECTION_REGISTERED | VERIFIED | Prior same-task private connection UI and real technical ID |
| TOOL_DISCOVERY_VERIFIED | VERIFIED | Prior same-task Refresh showed exactly arcanos_tutor |
| LIVE_TUTOR_CALL_VERIFIED | VERIFIED | Prior same-task expanded tool result reported model generation |
| GPT_BASELINE_CAPTURED | BLOCKED | Latest published configuration and knowledge inventory missing |
| GPT_MIGRATED | NOT_STARTED | No migration requested or performed |
| SKILL_RECONCILED | BLOCKED | Actual migrated skill and published instructions missing |
| REFERENCES_RECONCILED | BLOCKED | Actual published and migrated file inventories missing |
| PARITY_VERIFIED | BLOCKED | Old/new paired results absent; live formatting issue unresolved |
| PACKAGE_READY | BLOCKED | Actual artifact inspection and parity still required |
| RELEASE_READY | BLOCKED | Draft only; no replacement release or retirement |

Allowed statuses are VERIFIED, USER_REPORTED, IMPLEMENTED_NOT_VERIFIED, BLOCKED
and NOT_STARTED. VERIFIED always identifies its evidence domain. A successful
local test cannot verify account migration; user reports cannot become independent
account evidence merely by changing a label.

## Evidence provenance

[connection.requirements.json](../../integrations/arcanos-tutor/connection.requirements.json)
contains only non-secret metadata and sanitized summaries:

- Repository: fetched exact main and found no overlapping open PRs; isolated
  feature worktree; Tutor-only package and test changes.
- Railway: deployment `e14cfd48-0075-4996-b0dd-ec7b620d5d82` remains SUCCESS at
  the base SHA. Inspected configuration names only:
  `CHATGPT_MCP_ENABLED`, `CHATGPT_MCP_RESOURCE`, `CHATGPT_MCP_ISSUER`,
  `CHATGPT_MCP_JWKS_URL`, and presence of `OPENAI_API_KEY`.
- Public HTTP: protected-resource metadata returned the exact
  `https://acranos-production.up.railway.app/chatgpt/mcp` resource, Auth0 issuer
  `https://dev-etfsljoipfurdij6.us.auth0.com/`, and only `arcanos:tutor`.
  Anonymous MCP access returned 401 and readiness reported healthy. This is not
  authenticated discovery.
- Earlier authorized work in this same task: Auth0 policy configuration,
  completed OAuth linking, ChatGPT connection Refresh and the expanded real
  tool result were observed through the supported UI. The safe setup audit and
  task history support these dated observations. This PR did not repeat sign-in,
  refresh the catalog, inspect session data or make another provider call.
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
needs explicit reviewer identity/date and rationale; it is never inferred from
the narrowed backend scope. No differences have been accepted at this stage.

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
No deployment, key rotation, account migration, sharing or installation occurs.
The package does not add memory, profiles, persistence, ingestion or admin tools.

Before migration, abandoning the branch/package leaves the existing GPT and
registered app intact. Reverting repository changes cannot reverse a completed
account migration or restore GPT editability. After migration, the old GPT remains
usable only for the platform's remaining availability; its conversations are
not moved to the replacement. Retain the private baseline and avoid retiring any
route while parity is unresolved. A production rollback or retirement would
require its own explicit authorization; neither is carried out by this task.
