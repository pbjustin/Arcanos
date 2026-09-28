# Tutor migration independent review

Reviewed on **2026-09-24 UTC** by a separate reviewer subagent, independent of
the package/validator implementation. Scope: the current Tutor package, release
validator, capture helper, evidence ledgers, skill, migration handoff and focused
test definitions. Base: `3f9fffe48219b784dca758bca87ade109324c7c9`.

**Historical disposition: no remaining code-review blocker was found for the
reviewed draft package candidate after the corrections below. A separate review
of the subsequent backend/schema repair diff also found no code blocker. Final
tracked evidence/documentation review found no repository blocker. This is not release or
migration approval.**

## Findings resolved and rechecked

| Finding | Correction independently inspected |
| --- | --- |
| Unrelated verified evidence could promote a reported connection | A single evidence entry must satisfy both the verified status and the allowed evidence domain. Gates also validate their evidence domains. |
| Parity could survive changed references or packaged safeguards | Baseline fingerprints include published configuration and knowledge hashes; package fingerprints include the manifest, app mapping, final skill and approved references. Release compares those bindings. |
| Additional tool families escaped the dependency guard | The guard rejects the reviewed cross-capability identifiers, including memory, jobs, orchestration, generic dispatch and other product tools. Negative tests cover the previously missed names. |
| Contradictory gates and self-certified final readiness | Gate prerequisites and inventory consistency are checked. Package/release readiness is derived after actual input verification instead of required as an input assertion. |
| Review metadata could silently accept a behavioral difference | Accepted instruction/parity differences require separate acceptance identity, date, reason and artifact bindings. |
| A prior standalone call could certify unrelated plugin comparisons | Each verified parity result requires a verified ChatGPT observation bound to case, side, prompt, configuration fingerprint and sanitized-summary hash. Reported pairs cannot produce verified aggregate parity. |
| Duplicate reference approvals could hide an omitted reference | Migrated source paths and approved source/destination paths are unique; count and exact source matching enforce one-to-one package coverage. |
| A plausible replacement ID could appear registered | The validator pins the observed non-secret app ID and rejects changing both connection metadata and package mapping to an unobserved replacement. |
| Migrated metadata could select a different app while the ledger named Tutor | A verified migration requires the actual app-mapping artifact and registered app ID. Release resolves the manifest's mapping path, verifies the referenced file's hash and size, and checks its sole required app against the registered Tutor connection. |
| Completed parity could omit or incorrectly activate Tutor | Positive execution cases require `arcanos_tutor`; non-activation, memory/admin refusal and pre-call clarification cases require no invocation. |
| Credential labels could bypass content scanning through naming variants | The guard recognizes camelCase, underscore and hyphenated credential fields, plus encrypted and DSA private-key PEM labels. Twenty-six additional synthetic cases cover skill/reference rejection and non-disclosure in validator output. |

Reviewed implementation:
[validator](../../scripts/validate-arcanos-tutor-package.mjs),
[migration helpers](../../scripts/tutor-migration.mjs),
[capture command](../../scripts/capture-tutor-baseline.mjs), and
[package regressions](../../tests/tutor-pilot-package.test.ts).
The [private input contract](TUTOR_INPUTS.md) was also checked against the capture
command, artifact formats, publication assurance, parity bindings and release
workflow. It explicitly distinguishes repository input format from actual OpenAI
exports and leaves differing generated formats blocked for inspection.

The actual package contains the supplied non-secret app ID, one Tutor skill and
no knowledge files. The registered-app mapping follows the current documented
raw app-ID form. No credential/private-file leakage was observed in the reviewed
candidate. The distribution file allowlist, file/aggregate bounds, ancestor-link
checks and content guard remain in place. Private migration input is ignored.

At previewed head `7f4e8c6de2ad145be04de23a436a2dc106f118e7`, the backend/protocol
diff from base was empty. Subsequent scoped Tutor repairs address learner-directed
mathematical verification and connector-side nonempty-prompt validation; the
historical review is separate from the subsequent code review recorded below.
Existing GPT routes and Actions remain separate; the
[backend review](TUTOR_BACKEND_REVIEW.md) identifies both coverage scopes.

## Subsequent code and final evidence review

A separate reviewer inspected the Tutor arithmetic-policy repair, both honesty
passes, policy ownership and negative regressions, and found no code blocker.
The schema review also found no code blocker: four MCP SDK cases cover the
whole-string-compatible pattern, while 3,379 synthetic inputs showed no change in
JSON Schema acceptance. A final independent audit reviewed the aggregate changes
from `7f4e8c6de2ad145be04de23a436a2dc106f118e7` through repair commit `be56b7cc`
and the accompanying evidence/fixture changes. It found no remaining repository
blocker in publication integrity, private-content handling in tracked files,
gate status, fingerprint claims, parity, app mapping or formatting disposition.
The review did not inspect private inputs or certify account observations anew.

The final focused selection passed thirteen suites / 407 tests, and the separate
protocol selection passed four suites / 55 tests: 17 nonoverlapping suites / 462
tests, with zero failures or skips. The initial four-suite / 118-test repair
selection is covered by the broader selection. The old-guard negative control
failed the selected exact-answer regression with 11 other tests intentionally
skipped. Type-check/build passed after local Prisma client generation, lint passed
with zero errors / 76 existing warnings, and backend/CLI contract/offline checks
passed. Source package validation passed, release validation correctly exited 2
with `RELEASE_BLOCKED`, and sync check reported zero errors/warnings and five
informational notices. No result establishes complete historical-response
attribution or a live formatting fix; the repairs are not deployed.

- The [sealed preview run](https://github.com/pbjustin/Arcanos/actions/runs/35953275709)
  and independent clean-head verifier each passed 156/156 requests at exact head
  `7f4e8c6de2ad145be04de23a436a2dc106f118e7`, including 18 Tutor cases.
  The trusted workflow/verifier was `3f9fffe48219b784dca758bca87ade109324c7c9`.
  A real MCP SDK client passed six requests with a synthetic `generation: mock`
  Tutor response. This is separate from live OAuth or migrated-skill evidence.
- [Cleanup run](https://github.com/pbjustin/Arcanos/actions/runs/35954007244)
  succeeded; independent provider inventory showed the owned environment absent
  and both former hosts returned 404. The safe task-local report is
  `PR1509_PREVIEW_PROOF.md`; the [handoff](TUTOR_MIGRATION.md) records its scope.
- Public endpoint metadata at `2026-09-24T04:29:23.768Z` returned 200, the exact
  Tutor resource and only `arcanos:tutor`; anonymous MCP returned 401. A direct
  connected-tool attempt first returned `UNAUTHORIZED`. Same-account Reconnect
  subsequently completed at approximately 04:32 UTC and Refresh showed only
  `arcanos_tutor`, OAuth and the expected endpoint/app identity. A subsequent
  call was blocked before backend execution by connector `INVALID_ARGUMENT`
  prompt-schema validation. No fresh live Tutor answer is claimed; deployment,
  catalog refresh and actual live retesting of the local repair remain pending.
- Builder publication/completeness remains unconfirmed. The provisional old-GPT
  concise observation met the two-sentence request, but lacks a complete baseline
  fingerprint and is not an official parity result. Actual migrated artifacts
  and paired results remain unavailable.
- Ten old-GPT cases were observed provisionally, with no visible Action invocation;
  zero of sixteen official baseline-bound results are captured. The exact-format
  case showed one ordered list with three items; other cases sometimes used
  diagnostic framing. No case is promoted to PASS. Six cases remain unobserved:
  administration, auth failure, unavailable backend, timeout, cancellation and
  reference use. Controlled nonexecuting fixtures and the complete reference
  inventory remain prerequisites. Only safe summaries/hashes/timestamps are held
  in the ignored local record; this review does not publish its private contents.
- Review privacy claims apply to tracked repository and distribution content.
  Private Builder instructions, raw transcripts, knowledge bytes and session
  material must not be copied into this report or the tracked inventories.

Final evidence review retained the blocked baseline and post-migration gates.
Two wording findings were corrected and rechecked: the SDK boundary case is
8,000 ASCII characters (Unicode belongs to the separate comparison), and the
historical discovery entry now distinguishes the later account Refresh.
Tracked additions contained no private artifacts or credential-shaped matches;
the synthetic fixture owns its mock connection claims without weakening validation.
`MIGRATION_CHECKPOINT_READY` remains false. No accepted difference or final
migration/release-readiness conclusion is recorded by this update.

## Evidence limits and remaining migration blockers

This reviewer inspected source and test definitions; the implementer/root agent
owns execution results reported in the PR. No live provider, Auth0, ChatGPT,
production mutation, migration action, private export or credential store was
accessed for this review. Earlier connection observations are dated evidence,
not new parity results.

The validator checks consistency and recorded attestations; it cannot establish
that arbitrary local input really came from the latest published GPT or that an
attestation is truthful. Human inspection of the actual published and migrated
artifacts, exact-file publication approval and authenticated installed-client
observations remain required. Content-pattern scanning is not a substitute for
that review.

Published Builder configuration, actual migrated skill/references, and paired
behavioral evidence are still missing. The existing live response's formatting
issue remains unresolved. No behavioral differences have been accepted. Preserve
the blocked release gates and the separate explicit confirmation immediately
before any irreversible account migration.

## Candidate acceptance follow-up review — 2026-09-24

A bounded independent repair review reproduced the Test C cross-multiplication
false positive. A separate reviewer inspected the two-word vocabulary repair and
three regression additions without finding a code blocker. Generic, completed,
external and persistence claims remain protected. This is not a live Test C pass.

Independent baseline review found no private `published-gpt.json` or capture
output. All sixteen provisional prompt hashes and the ten available sanitized
summary hashes recomputed correctly; no complete configuration fingerprint or
publication confirmation exists. The official baseline-bound count stays 0/16,
all official result fields remain null, and no accepted difference exists.

The same independent reviewer checked the
[candidate acceptance handoff](TUTOR_CANDIDATE_ACCEPTANCE.md) against source and
current official documentation. It found no false deployment/readiness claim,
private-content publication or gate promotion. The real acceptance environment,
auth setup and separate ChatGPT connection remain unapproved and uncreated;
startup/access-boundary inspection must precede any future deployment. The
production mapping is preserved, and the PR remains draft.

## Post-#1510 reconciliation and runtime evidence review

On 2026-09-24 a separate reviewer inspected the current main merge and safe
evidence update against main `8af7a5712ebd5954a97af06ab31d0e2527ac0b58` and
prior migration head `55eeb0dc597acde29b541b25916cc2a1a744be22`.
No remaining evidence-publication or reconciliation blocker was found. This
verdict does not approve runtime release: **RUNTIME_ACCEPTANCE=FAIL** and
**LIVE_TUTOR_CALL_VERIFIED=BLOCKED**.

- All nine runtime/schema/test repair files and the schema guide match main.
- All 24 evidence hashes were independently recomputed: eight prompts, eight
  raw/display answers and eight sanitized summaries. Raw hashes cover structured
  answer strings; ChatGPT hashes cover visible plain-text transcriptions.
- The canonical schema hash matches the refreshed UI representation and main.
- The supported thread export confirms prepared prompts, including B's actual
  newline. Same-invocation ChatGPT tool arguments and raw results remain absent;
  no cross-request comparison or quotation was promoted to wrapper attribution.
- Raw results (1 pass/3 failures) are separate from ChatGPT display results
  (1 pass/3 failures) and zero fully evidenced raw/final paired passes.
- All sixteen parity rows remain BLOCKER, with oldGpt/plugin fields null.
  Baseline and migrated-artifact gates remain blocked; no accepted difference.
- Tracked additions contain reviewed metadata/hashes/summaries, not private
  conversations, Builder/knowledge contents or credentials.

Stale in-progress wording and ambiguity about visible-text versus Markdown hash
provenance were corrected. A separate read-only source reviewer also confirmed
the [runtime report's](TUTOR_RUNTIME_ACCEPTANCE.md) deterministic honesty cases
and caveat/list interaction. Constructed pre-guard strings were not captured live
provider text; source policy forwarding is not runtime option attestation.
Neither reviewer invoked Tutor, changed production/authentication, or edited
backend code. Final documentation/sync/staged-guard checks follow these text edits.

## Current-main reconciliation review (2026-09-25)

A separate reviewer inspected the reconciliation of #1509 prior head
`68bd5eeebf63f637ccd743110d81da5cce1b1991` with current main
`71672aec22d7babf62d65b96de667f17abd3f219`. No in-scope blocker was found:

- Runtime/protocol/preview/workflow and production-documentation paths match main
  exactly; no #1511/#1512/#1513 change was reverted or recopied as migration work.
- All four generated indexes match main after regeneration/content comparison.
- Remaining differences are migration/package tooling, metadata, evidence and
  private-input safeguards. No private-input path is tracked or staged.
- Gates remain evidence-consistent. The post-#1512 failed acceptance record is
  corroborated in #1509 and #1513; sealed #1513 evidence remains synthetic.
- All 16 official old-GPT/plugin result fields remain null and blocked. The
  10 provisional observations do not establish published-baseline parity.
- No migration-complete or live-acceptance success claim is made. #1509 is safe
  to retain as the draft final migration container, not ready for migration/release.

The reviewer suggested clarifying dated connection/discovery wording. Current
handoff and ledger notes now explicitly identify September 24 observations;
no new account inspection or refresh is implied. Current validation and the owner
checkpoint are in [the reconciliation record](TUTOR_RECONCILIATION_20260925.md).

## Partial baseline evidence review (2026-09-25)

Independent reviewers inspected the private read-only UI artifacts without
publishing raw contents, the safe hash inventory and all ten provisional cases.
All 11 referenced source hashes and byte sizes matched. The complete current-version
instruction field and Action schema were captured privately; the YAML and JSON
schema objects are identical, with two resolving internal references. The existing
credential guard passes the JSON representation without a validator change.

The selected current-version model differs from the editor. Version History omits
starters and knowledge; editor emptiness is not proof of published zero entries.
Schema-declared OAuth does not prove stored Action authentication configuration.
Exact publication timestamp/timezone and complete latest-publication review remain
missing. Consequently GPT_BASELINE_CAPTURED stays BLOCKED and no baseline
fingerprint exists. All ten old-GPT observations remain provisional because their
configuration identity is unbound; all sixteen official result fields remain null.
No GPT prompt, account migration or backend/provider call was made.

See [the partial capture record](TUTOR_BASELINE_CAPTURE_20260925.md). This is a
consistency/privacy review of partial evidence, not completed-baseline verification.

## Complete private capture follow-up (2026-09-25)

Independent review matched the complete private input to the captured current
version and the owner's explicit confirmation of zero starters, zero knowledge
and stored Action authentication None. The published Action-list display label
is used as the group name; operationId ask and schema-declared OAuth remain
distinct from stored authentication. Sharing uses current account-header evidence.
The timestamp preserves the literal calendar minute with timezone unavailable;
no offset, seconds or exact instant was invented. Seven expected-behavior
entries match the reviewed private artifact and are not observed runtime results.

Two CLI captures and an independent in-memory capture agree. Fingerprint:
`eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25`.
Complete-transcription owner review remains pending at this checkpoint; technical
validation alone does not advance GPT_BASELINE_CAPTURED.

All ten provisional observations fit the publication chronology but lack the
retained execution identity needed to bind them to this specific published GPT.
No baseline-at-execution fingerprint requirement was invented; a retained
conversation/session locator or source record could resolve the gap without a
new call. Counts remain 16 total, 0 bound, 10 provisional and 6 unexecuted.

## Owner approval follow-up (2026-09-25)

Independent review verified the actual owner confirmation following the direct
complete-file review link. The private review sidecar binds the approval to the
unchanged 10,925-byte published configuration and baseline fingerprint
`eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25`.
The successor private checklist has all 18 required fields VERIFIED. The seven
source-derived expected-behavior summaries are included in owner approval; no
new observed behavior or parity evidence was generated.

The reviewed inventory records Owner (task confirmation), 2026-09-25T20:00:43Z,
and latestPublishedConfirmed=true. Publication assurance and owner evidence
remain USER_REPORTED; publicationReview references actual account/owner evidence,
while repository verification establishes source integrity and determinism.
Only GPT_BASELINE_CAPTURED changes status. Independent review found no blocker in
the provenance, private-input boundary, or gate transition. Historical pending
review records remain historical. Parity stays 16 total, 0 bound, 10 provisional
and 6 unexecuted; live runtime acceptance remains blocked and migration is not
authorized. GitHub was confirmed OPEN/DRAFT with auto-merge disabled and no merge.
