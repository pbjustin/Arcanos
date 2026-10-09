# Regression inventory

All new documents are synthetic. No fixture reproduces protected publisher text.
The selected Gaming/fetcher suites retain existing rejection and orchestration
coverage alongside these positive regressions.

| Requirement | Executable coverage |
| --- | --- |
| Ordinary `early game:` prose is not a game declaration | `gaming-live-source-identity-regressions.test.ts`, `gaming-publisher-extraction-regressions.test.ts` |
| Generic Samurai, Dexterity and gameplay headings do not invent identities | `gaming-acquired-topic-identity.test.ts`, `gaming-live-source-identity-regressions.test.ts` |
| Verified article survives unrelated recommendations, comments and sidebar qualifications | `gaming-live-source-identity-regressions.test.ts`, `gaming-publisher-extraction-regressions.test.ts` |
| Full primary prose survives card competition and presentation tables | `gaming-publisher-extraction-regressions.test.ts` |
| Closed independent records retain fields, source identity and qualifications through long prose and layout wrappers | `gaming-publisher-extraction-regressions.test.ts`, `gaming-html-evidence.test.ts` |
| Relevant late evidence is selected from the full accepted pool | `gaming-live-source-candidate-regressions.test.ts`, `gaming-large-guide-rag.integration.test.ts` |
| Complementary Samurai bleed topics retain each passage's citation provenance | `gaming-live-source-candidate-regressions.test.ts` |
| Genuine different-game and Nightreign subjects, including an actual leading heading behind a misleading SEO title, remain distinct | `gaming-live-source-identity-regressions.test.ts`, `gaming-body-identity.test.ts`, `gaming-game-identity.test.ts` |
| Best/The best prefixed primary Nightreign subjects and DLC scope cannot hide behind a matching base-game SEO title; normal prefixed base-game guides and unrelated comparisons remain applicable | `gaming-acquired-topic-identity.test.ts`, `gaming-live-source-validation-preview.test.ts` |
| DLC-only instructions and contradictory records fail closed | `gaming-live-source-identity-regressions.test.ts`, `gaming-unrequested-base-edition.test.ts`, `gaming-structural-sufficiency.test.ts` |
| Truncated, malformed or qualification-incomplete records cannot establish unqualified facts | `gaming-publisher-extraction-regressions.test.ts`, `gaming-html-evidence.test.ts`, `gaming-partial-guide-admission.test.ts` |
| Missing or mismatched provenance and unsupported currentness remain rejected | `gaming-live-source-candidate-regressions.test.ts`, `gaming-currentness-candidates.test.ts`, `gaming-freshness.test.ts` |
| Unsafe URL/redirect/private-network transport and injection remain rejected | `gaming-protected-transport.test.ts`, `gaming-document-resolution.test.ts`, `protected-document-byte-budget.test.ts`, `gaming-samurai-guide-workflow.integration.test.ts` |
| Oversized and inaccessible responses stop before generation/storage | `gaming-document-resolution.test.ts`, `gaming-samurai-guide-workflow.integration.test.ts`, `gaming-mixed-candidate-failures.test.ts`, `gaming-source-discovery.integration.test.ts` |
| New served proof cannot be omitted or replaced with a success label | `gaming-live-source-validation-preview.test.ts`, `native-pr-preview-application.test.ts`, `scripts/native-pr-preview-e2e.test.mjs` |
| Early freshness game rejection reports the actual failed rule with redacted request/trace/workflow/candidate correlation and no generation/storage | `gaming-acquired-topic-identity.test.ts` |
| Embedded JSON retains a late qualification after 107 ordinary paragraphs; genuine qualifier overflow remains partial | `gaming-publisher-extraction-regressions.test.ts`, `gaming-live-source-validation-preview.test.ts` |

The former generic-topic mismatch expectation is replaced with a precise
different-game title/body case. Tests for actual qualifier overflow and omitted
semantic scope replace an expectation that ordinary paragraph count alone makes
all records incomplete. Existing explicit declarations, wrong-game, edition,
currentness, unsafe transport, injection and partial-record negatives remain.

The complete command manifest, executed totals, toolchain and source fingerprints
are recorded in the PR's verification evidence. Local served HTTP is separate
from trusted hosted verification, which is blocked by non-draft preview admission.
