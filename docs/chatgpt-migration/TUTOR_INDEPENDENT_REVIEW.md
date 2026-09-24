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
