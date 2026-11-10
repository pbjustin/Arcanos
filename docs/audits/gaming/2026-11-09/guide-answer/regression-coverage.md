# Guide-to-answer regression coverage

This maps the assignment's 18 regression categories to permanent tests. **New**
means added by this repair; **reused** means existing coverage retained. The
existing discovery-framing suite also updates its explicit starting-procedure
expectation and complementary positive example. No new publisher parser or
public MCP contract is introduced.

The table describes test ownership, not an aggregate pass claim. Final validation
results must distinguish executed, failed and skipped checks; a guarded
PostgreSQL suite establishes SQL behavior only when its disposable target runs.

All linked test paths are repository-relative. Authored source/model fixtures are
synthetic. The separately retained Frontier article is genuine publisher
material; its [sanitized source receipt](frontier-acquisition.json) and
[diagnosis](frontier-diagnosis.md) publish measurements and hashes rather than
the article body.

| # | Requested category | Permanent coverage and boundary |
| --- | --- | --- |
| 1 | Elite question and accepted Frontier evidence | **New:** [request selection](../../../../../tests/gaming-guide-request-selection.test.ts) reproduces the exact long question with clearly authored complementary passages; [answer delivery](../../../../../tests/gaming-guide-answer-delivery.integration.test.ts) requires selection, coverage and final audited delivery through authenticated MCP. Actual Frontier acquisition and selection are separate source-component evidence in the receipt. |
| 2 | Single-topic guides | **New:** request-selection and answer-delivery tests cover ordinary short colonisation questions. **Reused:** [ordinary request coverage](../../../../../tests/gaming-ordinary-request-coverage.test.ts) preserves narrow preparation, item and action requests without inventing independent topics. |
| 3 | Complementary multi-part requests | **New:** exact Elite prerequisite/start passages and separate Rex/Nia source bindings. **Reused:** [discovery recovery](../../../../../tests/gaming-discovery-recovery.integration.test.ts) combines independent acquired clauses and retains earlier-round evidence. |
| 4 | Presentation wording | **New:** source discovery, steps and citation instructions are excluded from gameplay requirements. **Updated/reused:** [discovery request framing](../../../../../tests/gaming-discovery-request-framing.test.ts) preserves concrete starting subjects and spoiler constraints. |
| 5 | Conservative related wording | **New:** prerequisite requests match actual requirement relations; begin/start questions match acquired procedural grammar. Named Start Stone and Requirements objects, unsupported topics and negated starts remain negative controls. This is bounded grammar, not general semantic retrieval. |
| 6 | Useful passages with different wording | **New:** the natural Elite and Chapter 2 role questions reach acquired instructions without requiring presentation verbs or the exact question framing. **Reused:** discovery-framing retains a concrete getting-started subject and rejects unsupported synonym-only material. |
| 7 | Missing prerequisites | **New:** starting instructions without an acquired prerequisite leave coverage false; useful partial evidence remains available. Requirements headings and unrelated or motivational statements cannot supply the missing relation. |
| 8 | Unsupported or contradictory claims | **New:** uranium/quantum-crystal quantities stay unverified and an invented answer quantity is withheld. **Reused:** discovery-recovery rejects conflicting structured records before generation; [CLEAR evidence](../../../../../tests/gaming-clear-evidence.test.ts) retains combined evidence gates. |
| 9 | Partial but intact extraction | **Reused:** [web context quality](../../../../../tests/gaming-web-context-quality.test.ts) exercises intact partial prose and qualifications. The actual Frontier receipt proves all nonempty article paragraphs survived while structured-state inspection exhausted its bound. No parser repair or budget increase is claimed. |
| 10 | Citation-to-evidence binding | **New:** delivery checks source number, accepted URL, selected record and revision identity, and rejects a claim attached to the other accepted source. **Reused/extended:** [source evaluation stages](../../../../../tests/gaming-source-evaluation-stages.test.ts) retains acquired-document membership and adds count-only selection diagnostics. |
| 11 | Spoiler restrictions | **New:** Elden Ring and Chapter 2 delivery retain conservative spoiler context. **Reused:** [retrieval policy](../../../../../tests/gaming-retrieval-policy.test.ts) and discovery-framing exclude unrelated future-story passages and headings; [hybrid workflow](../../../../../tests/gaming-hybrid-workflow.test.ts) withholds replay when spoiler permission tightens. |
| 12 | Wrong game or edition | **Reused:** source-evaluation stages distinguish independent game proof from genuine edition/platform conflicts; [colonisation extraction](../../../../../tests/gaming-colonisation-extraction.test.ts) rejects foreign or unverified ownership despite topical delivery vocabulary. |
| 13 | Source-wide platform/patch restrictions | **Reused:** [stored source scope](../../../../../tests/gaming-generic-stored-source-scope.test.ts) retains global platform metadata outside local rows; [freshness](../../../../../tests/gaming-freshness.test.ts) and CLEAR evidence retain explicit patch/build/edition conflicts. [Source-scope negation](../../../../../tests/gaming-source-scope-negation.test.ts) preserves negative applicability declarations. Request cleanup does not rewrite original applicability input. |
| 14 | Source instructions and injection | **Reused:** discovery-recovery rejects source instructions without changing request, budgets or storage policy; [protected HTTP boundary](../../../../../tests/gaming-source-http-boundary.test.ts) retains HTTPS/SSRF/transport controls. No script execution or publisher-access bypass is added. |
| 15 | Recovery after failed publishers | **Reused:** discovery-recovery exercises unsupported/access failures, replacement URLs, retained useful evidence and the terminal recovery limit. Publisher denial is not turned into successful acquisition. |
| 16 | Budgets, expiry and cancellation | **Reused:** [v2 lifecycle](../../../../../tests/gaming-hybrid-v2-lifecycle.test.ts) covers round charging, absolute TTL, stale revisions, actor scope and cancellation; hybrid-workflow preserves v1 retries and expiration. [Evidence selection](../../../../../tests/gaming-hybrid-evidence-selection.test.ts) covers bounded passage/context selection; [hybrid edition budget](../../../../../tests/gaming-hybrid-edition-budget.test.ts) retains acquisition charging across equivalent edition scopes. |
| 17 | PostgreSQL source authority | **Reused, guarded SQL:** [durable RAG](../../../../../tests/integration/gaming-durable-rag.pg18.integration.test.ts), [authority read](../../../../../tests/integration/gaming-authority-read.pg18.integration.test.ts) and [hybrid authority revocation](../../../../../tests/integration/gaming-hybrid-authority-revocation.pg18.integration.test.ts) exercise held-history grants, revision binding, refill and revocation during recovery. Mocked [authority tests](../../../../../tests/gaming-source-authority.test.ts) are separate from PostgreSQL evidence. |
| 18 | Final-answer auditing | **New:** full delivery requires the actual audit boundary and withholds unsupported numerical and cross-source citation claims. **Reused:** [answer audit](../../../../../tests/gaming-clear-answer-audit.test.ts) covers exact answer/passages, citation bounds, spoiler violations, unavailable audits, cancellation and unchanged partial-extraction limits. |

The [delivery contract assessment](delivery-contract.md) explains why qualified
partial answers remain a separate compatibility follow-up. These regressions do
not set `coverageSatisfied` to true for missing facts. Synthetic SDK responses
prove orchestration and enforcement, not real-model judgment, live citation
accuracy or production latency. Real Trinity model execution and an actual
player-facing answer at the repaired SHA remain separate live acceptance gates.
