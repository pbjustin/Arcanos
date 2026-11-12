# PR #1597 grounded answer investigation

The starting head was `b5beb546b8b0ba2efd019f971cb626fd0dde5411`. The
sanitized receipt for `c874a299-4538-422d-82dc-9e7c16cd6099` records successful
acquisition, source validation, selection of two passages, and completed Trinity
and CLEAR stages. CLEAR rejected the candidate and delivery withheld the guide
and citations.

| Finding | Count | What the receipt establishes |
| --- | ---: | --- |
| `FALLBACK_PRESENTED_AS_COMPLETED` | 1 | CLEAR reported a completion concern. The receipt's fallback flag describes the response envelope after withholding. |
| `MATERIAL_FACT_UNRESOLVED` | 1 | A material uncertainty was reported. The server can also derive this finding from unresolved facts on a dimension. |
| `PROFILE_FLOOR_NOT_MET` | 1 | A floor finding was recorded. The server can derive it when all five dimensions are evaluated and a floor fails. |
| `UNSUPPORTED_CLAIM` | 1 | CLEAR reported an unsupported claim. Its text, citation and evidence association are unavailable. |

The receipt retained finding counts and provider completion status. It did not
retain the candidate, the exact audited passages, individual finding origins or
the five scores. The patch-warning visibility flag describes the public
response. It cannot establish whether the audit candidate had an extraction
warning. The counts cannot identify four independent gameplay errors.

CLEAR v7 compares the weighted overall score to 4, clarity to 3.5, alignment
to 4, and resilience to at least 3.5. Leverage and efficiency contribute to the
weighted score. The existing decimal boundary tests cover the overall floor.

## Offline claim-to-evidence matrix

The authenticated guide-delivery tests use authored publisher and SDK fixtures.
The evidence identifiers below refer to fixtures in the
[guide delivery suite](../../../../tests/gaming-guide-answer-delivery.integration.test.ts).
For each claim the synthetic judge receives the exact answer and selected
passages, then the real audit parser and delivery gate handle the verdict.

| Claim ID | Claim type | Evidence ID | Support status | Missing requirement | Audit expectation | Fixture result |
| --- | --- | --- | --- | --- | --- | --- |
| ELITE-START | Prerequisite and order | Scenario C, selected Frontier URL fixture | Supported | None | Accept | Delivered with its selected citation |
| ELITE-PERMIT | Prerequisite | Scenario C, selected Frontier URL fixture | Unsupported | No passage requires a Founder's Permit | Reject | Withheld |
| ELITE-ORDER | Action order | Scenario C, selected Frontier URL fixture | Contradicted | Acquire the claim before deploying the ship | Reject | Withheld |
| ZELDA-PRICE | Quantity | Scenario A, Kokiri Shop passage | Contradicted | The selected passage states 40 Rupees | Reject | Withheld |
| XENO-INDEX | Source attribution | Scenario D, Nia passage cited for Rex | Unsupported by cited passage | Rex's guidance requires the selected Rex passage | Reject | Withheld |
| IVORY-LIMIT | Partial extraction | Scenario E, intact passage from partial source | Supported with qualification | Preserve the source limit in the audited and delivered text | Accept | Delivered with the exact audited qualification |

Standalone refusal text is withheld before audit dispatch. A capability
limitation followed by supported, cited instructions still receives one audit.
The [citation regressions](../../../../tests/gaming-clear-answer-audit.test.ts)
also cover descriptive Markdown labels and numbered links that disagree with
their URL. Unknown numeric references continue to fail.

## Remaining coverage and live acceptance

The original Elite Dangerous question can report complete coverage when a
fixture supplies a prerequisite and only one starting action. For reproduction,
use the original question and two intact passages: “To begin system colonisation,
visit the System Colonisation Contact.” and “Registering a star system for
colonisation requires credits; the cost depends on the selected initial
station.” The coverage assessor returned `coverageSatisfied: true`.
Raising the plural step minimum exposed a coupled excerpt issue. In an older retained
Frontier acquisition, the projected excerpt ends after the first action.
Further ordered actions appear in the acquired article, including a passive
interface handoff the current procedure matcher does not bind. Applying the
stricter minimum alone rejected supported fixtures. The interim change was
reverted. The exact passages from run `c874a299-4538-422d-82dc-9e7c16cd6099`
are unavailable, so this reproduction cannot attribute that run's findings.

A separately authorized live acceptance requires a fresh one-shot ID, an
attested isolated target at the final PR commit, green required CI, an approved
credential, the existing $2 cap and zero retries. Run the positive Frontier
case and proceed to the wrong-game control only after verified cited delivery.
Preserve the sanitized receipt and verify provider stop and process cleanup.
Keep content capture disabled unless separately approved under the
[private diagnostic constraints](../../../LIVE_VALIDATION.md#diagnosing-rejected-answers).
