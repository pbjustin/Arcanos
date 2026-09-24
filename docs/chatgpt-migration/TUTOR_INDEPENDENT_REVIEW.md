# Tutor migration independent review

Reviewed on **2026-09-24 UTC** by a separate reviewer subagent, independent of
the package/validator implementation. Scope: the current Tutor package, release
validator, capture helper, evidence ledgers, skill, migration handoff and focused
test definitions. Base: `3f9fffe48219b784dca758bca87ade109324c7c9`.

**Disposition: no remaining code-review blocker found for the draft migration
candidate after the corrections below. This is not release or migration approval.**

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
| Completed parity could omit or incorrectly activate Tutor | Positive execution cases require `arcanos_tutor`; non-activation, memory/admin refusal and pre-call clarification cases require no invocation. |

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

The backend/protocol diff is empty. No new memory, persistence, administrative
operation, generic dispatch, or cross-product tool is introduced. Existing GPT
routes and Actions remain separate; the [backend review](TUTOR_BACKEND_REVIEW.md)
identifies their regression coverage.

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
