# PR #1597 Gaming CLEAR evidence verification

Baseline `13bdb38f9b88212ee5259a63aaaed423ab5d9091`, with original base
`2df6e6a0fb409aaa42e1b5f687ea2622c8dde560`.

## Baseline decision flow

The [Gaming hybrid workflow](../../../../src/services/gamingHybridKnowledge.ts)
acquires public guide material and checks source authority. The
[evidence policy](../../../../src/shared/gaming/gamingClearEvidence.ts) and
[retrieval policy](../../../../src/shared/gaming/gamingRetrievalPolicy.ts)
check selected passages for independent identity, applicability, provenance,
security, relevant conflicts and requested coverage. The
[Gaming pipeline](../../../../src/services/gamingPipeline.ts) requires an
accepted evidence assessment before generation.

[Trinity](../../../../src/core/logic/trinity.ts) checks provider output integrity
and applies honesty controls. The Gaming pipeline adds any required qualification
and sends the exact candidate and selected passages to the
[mandatory answer audit](../../../../src/services/gamingClearAnswerAudit.ts).
The audit model reviews material claims and citations and supplies the five CLEAR
dimension scores. The [server policy](../../../../src/shared/gaming/gamingClearPolicy.ts)
validates the projection, applies blocking findings and score floors, and makes
the delivery decision. Delivery rechecks source authority, evidence and citation
membership, required qualifications, and binding to the exact approved answer
and context.

[Booker CLEAR](../../../../src/services/backstageBookerClear.ts) asks the
generation model to draft, review and revise against the five dimensions under
the server's authority rules. It returns the final booking or review. Gaming
adds a separate source-backed review of the final candidate and a server-side
delivery gate.

| Question | Baseline behavior |
| --- | --- |
| What establishes claim support? | Request coverage identifies passages with the required evidence. The semantic audit evaluates the actual statement against the passages behind its citation, including quantities, prerequisites, action relationships and scope. Deterministic citation membership is necessary where a citation is required. |
| How are missing and contrary evidence distinguished? | Evidence selection already tracks unknown applicability separately from verified conflicts and compares structural records for incompatible assertions. Final semantic findings can describe both issues, but no explicit answer-level taxonomy distinguishes them. |
| Can quality alone withhold a supported answer? | Yes. A completed audit with no material findings can still fail the weighted overall, clarity, alignment or resilience floor. |
| Can uncertainty block without a separate claim finding? | Yes. A nonempty `unresolvedFacts` entry on any answer dimension derives `MATERIAL_FACT_UNRESOLVED` without a separate finding or claim identifier. |
| Can one issue produce overlapping findings? | Yes. A material finding can also result in unresolved facts and lower scores, yielding multiple blocking labels. At baseline, an unlisted patch reference also produced a compatibility conflict and unevaluated dimensions from the same preflight stop. |
| Are missing optional and mandatory details distinguished? | Retrieval identifies material request clauses, including explicit prerequisites and ordered steps. The baseline audit instructions mention unseen guide sections and missing prerequisites without stating which unknowns belong in the blocking `unresolvedFacts` field. |
| When can a qualification cause withholding? | A missing fact remains blocking when the request requires it. A source limitation by itself can accompany a complete supported answer. Baseline preflight can also reject a narrowly phrased honest qualification before the model sees it. |
| Does absence become contradiction? | In one deterministic patch check. A patch outside the set of known versions produces `ANSWER_PATCH_CONFLICT`, even if the evidence merely omits that version. |
| Does wording matter? | The patch scanner lets a bounded sentence using “does not establish whether” reach the model. The same sentence using “does not confirm whether” matches the affirmative patch scan at baseline. |
| What is retained? | The internal assessment binds the final answer hash and context and contains scores, codes and evidence references. Public receipts retain bounded diagnostics. They lack rejected answer text, the exact audited passages, and the detail needed to recover historical claim decisions. |

## Evidence-first answer policy

`SUPPORTED` requires substantively applicable evidence. A valid citation or
high CLEAR score alone cannot establish support. `UNVERIFIED` means the
available evidence leaves the claim open. `CONTRADICTED` requires affirmative
incompatible evidence in a selected, applicable passage. Apply the same rules to
walkthrough steps and prerequisites, build mechanics and requirements,
explanations, quantities and acquisition locations, and patch-specific or
historically scoped claims.

Use the existing bounded findings contract for the versioned internal
projection. An explicit `CONTRADICTED_CLAIM` requires a selected chunk
reference. A missing reference leaves the diagnostic unverified and delivery
blocked. A selected reference binds the audit's judgment to an eligible passage.
The model still supplies the semantic judgment. A completed semantic review
without a material fact blocker can report support separately from a quality-only
rejection.

An affirmative assertion about an unlisted patch stays blocked as unsupported
currentness. The bounded standalone “does not confirm whether” qualification
can reach the semantic audit. A second affirmative claim in the same answer
still has to pass preflight and the audit. The model instructions reserve
`unresolvedFacts` for material facts needed to answer the request and require
the answer to preserve material source limitations.

CLEAR v7 keeps the existing delivery floors of overall 4.0, clarity 3.5,
alignment 4.0, and resilience 3.5. The public wire contract, evidence and source
authority gates, required qualifications, mandatory one-call audit and
fail-closed delivery continue to apply.

## Historical observations and offline calibration

`UNSUPPORTED_CLAIM` reports missing support without establishing
contradiction. `MATERIAL_FACT_UNRESOLVED` can report a missing request
requirement. `PROFILE_FLOOR_NOT_MET` concerns quality.
`FALLBACK_PRESENTED_AS_COMPLETED` concerns answer integrity.
`UNCLASSIFIED_AUDIT_FINDING` has ambiguous meaning in historical receipts.
The same underlying issue can contribute to several codes. The retained
rejection counts cannot identify historical claims, their supporting passages
or the scores. The latest live run at the baseline timed out on source
acquisition before it reached the audit.

The [retained Frontier replay](../2026-11-10/pr1597-remediation/frontier-selection-replay.json)
and [prior guide-delivery controls](../2026-11-12/pr1597-grounded-answer.md)
provide offline evidence for required prerequisites, starting steps, the
one-action negative control, citation scope and delivery. Use independent
claim-to-passage expectations with the
[answer audit suite](../../../../tests/gaming-clear-answer-audit.test.ts) and
[guide-delivery integration suite](../../../../tests/gaming-guide-answer-delivery.integration.test.ts)
to check the new classification and unchanged delivery safeguards. A
deterministic provider fixture tests the application and decision contract. It
cannot establish the live audit model's accuracy or the production rejection
rate.

The [calibration corpus](../../../../tests/gaming-evidence-first-corpus.test.ts)
contains 14 independently labeled cases and six validation controls. Of the six
factually supported cases, four passed delivery, one failed the Clarity floor
alone (3.25 against 3.5, weighted overall 4.1875), and one omitted a mandatory
prerequisite. All six unverified cases and both contradicted cases were
withheld. The unverified cases include one wrong-citation control. The
historical Frontier beacon excerpt was checked against the retained acquisition
hash. Other passages are authored or paraphrased for the fixtures.
