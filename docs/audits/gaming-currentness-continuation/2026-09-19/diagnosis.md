# Gaming currentness continuation diagnosis

Inspected base: `228291e7` (2026-09-19), before implementation.

## Root cause

The backend already has a nonterminal `discovery_required` / `verify_currentness` response and a distinct currentness operation. The accepted gameplay submission is retained; the caller must submit the same workflow with a new operation key. A guide alone correctly remains unverified. The reported production interaction is consistent with the caller stopping at this handoff; no raw production trace was supplied to independently identify its exact caller decision.

The repository nevertheless contains deterministic orchestration defects that make the handoff fragile:

- `gamingHybridKnowledge.ts` emits generic official/latest search strings even though `REVIEWED_GAMING_SOURCE_RULES` contains exact reviewed current-index locations.
- A reviewed index adapter can discover `requiredArticleUrl` only after acquisition. The candidates operation spends its one currentness round before evaluation, but `gamingHybridCandidates.ts` fetches only caller-supplied URLs. An index-only submission therefore exhausts the round before the caller can submit its required companion. Existing success tests manually know both URLs.
- `discovery()` and `currentnessReason` recognize only patch-sensitive/seasonal questions and two reason codes. Live-status requirements and missing current-build evidence can stop against the already spent gameplay round while the official verification budget is unused. The candidates authority gate also excludes the reviewed official-status role.
- GPT instruction step 6 requests continuation, but step 7 allows stopping when the official step ends stale/unverified without explicitly distinguishing the pre-operation response. OpenAPI descriptions do not establish that `verify_currentness` obligates a follow-up, and discovery metadata does not expose canonical reviewed sources.

## Existing safeguards traced

Query retrieval flows through `answer()` and the freshness/applicability/CLEAR gates before generation. `candidateSubmission` retains bounded gameplay knowledge and freshness; currentness submission recombines them without requiring guide resubmission. Gameplay and currentness have separate one-round budgets, charged before asynchronous evaluation. Payload-hashed operation promises reuse successful retries; changed payloads conflict. Actor ownership and normalized query budgets prevent another actor or new idempotency key from obtaining extra rounds. Workflows are process-local and expire after the smaller of ten minutes and the freshness-class deadline; restart/replica misses return a safe not-found result. The retained full-document cap can remove storage artifacts but preserves bounded answer evidence.

Registry rules select exact game/host/path authority. Adapters distinguish indexes from articles and require explicit linkage, active releases, matching patch/build, platform/region, supported extraction, and fresh verification. `combineGamingCurrentnessEvidence()` and guide applicability recompute before the single answer generation. Conflicting/incomplete evidence remains fail-closed. HTTP 403, size/timeout, redirects, extraction, and source-policy failures remain acquisition failures, never proof that no update exists.

## Smallest coherent repair

Expose bounded reviewed canonical currentness hints and explicit required/exhausted continuation metadata; define caller follow-up obligations. Acquire only adapter-required reviewed companion articles within the same existing three-source / twelve-second currentness operation, preserving resolver admission and final identity checks. Use generalized freshness requirements for pending official index, build, and live-status verification. Keep one gameplay round and one currentness round, retained evidence, idempotency, expiry, and fail-closed applicability. Add focused lifecycle and authority regressions that consume returned hints rather than hardcoded companion URLs.

Hosted native PR previews currently exercise sealed pure-core Gaming fixtures, not the normal authenticated hybrid workflow or real publishers. Preview evidence must distinguish those boundaries from the HTTP integration harness and production behavior. No Builder configuration, production deployment, or merge is part of this change.
