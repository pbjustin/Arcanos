# Gaming currentness continuation validation

Date: 2026-09-19. Base: `228291e75179301411b75f53d47bc66d537f5eff`.
Toolchain: Node `24.18.1`, npm `11.16.0`.

## Diagnosis and behavior

The [pre-edit diagnosis](diagnosis.md) traces the existing retention and round controls. The repair adds mandatory nonterminal continuation semantics, bounded reviewed registry hints, and acquisition of an adapter-required official article inside the existing three-document/twelve-second operation. It generalizes missing-build, seasonal, and live-status continuation without relaxing official proof. Applicable contradictory official status evidence remains negative evidence. No game-name branch or new source authority rule was added.

## Local validation

- Gaming suite: **82 suites, 2,451 tests passed**, including OpenAPI, Hybrid lifecycle/workflow, currentness adapters/document parsing, freshness/applicability, resolver/transport, durable retrieval/ingestion, and sealed component fixtures.
- Native preview application/import-boundary suites: **377 tests passed**.
- Authenticated Hybrid HTTP lifecycle suite after strengthening compressed decoded-limit proof: **93 tests passed**.
- Type-check and full build: passed, including source and emitted preview import containment.
- Lint: passed, with 76 existing warnings and no errors.
- Documentation and local-link checks: passed. External documentation links were intentionally not checked.
- Backend/CLI contract and Python offline validators: passed.
- `sync:check`: zero errors/warnings; five existing informational observations.
- Commit guard and whitespace check: passed before publication.

An initial broad run overlapped the final live-status test edits and exposed shared test-client HTTP rate-limit exhaustion after adding scenarios. The fixture now uses an isolated synthetic client per workflow while retaining the real limiter; the stable complete rerun passed. No production budget was raised.

## HTTP proof

[Captured request/response trace](http-lifecycle.json) contains only authored synthetic inputs and no authentication headers. It runs actual loopback HTTP through the authenticated Gaming router and production workflow, resolver, extraction, source policy, adapters, applicability, CLEAR, and pipeline. DNS/publisher bytes, SQL storage boundary, and provider completions are controlled fixtures. It does not prove live publisher content, PostgreSQL behavior, ChatGPT web-tool execution, or a production deployment.

The recorded workflow is `b049b8d3-68a5-4e78-883e-20f7ed23a0ee`:

| Request | Result |
| --- | --- |
| `POST /gpt-access/gaming/sources/hybrid/query` | `discovery_required / search`, gameplay round 0 |
| Gameplay candidates with returned workflow ID | One guide accepted; unrelated candidates rejected; `verify_currentness`, currentness round 0, `continuationRequired: true`; zero generation |
| Currentness candidates with same workflow ID and a new key; only returned reviewed index URL submitted | Index independently acquired; required official article acquired via adapter relationship; patch/build/platform verified; retained guide applicability recomputed |
| Official result | `answer_ready / answer`, freshness `current`, applicability `verified_current`, exactly one answer and one currentness operation |
| Duplicate official submission and equivalent query | Same answer; no additional acquisition or generation |
| New official key | 409; no extra round |

The five acquisitions comprise the guide, two rejected gameplay distractors, official index, and required official article. No guide resubmission or persistent write occurs. Other HTTP tests cover failed companion acquisition (403 and actual gzip expansion hitting `DECODED_LIMIT`), exhaustive terminal results, mismatched scopes, conflicting evidence, and idempotency.

To regenerate a trace, set the test-only `GAMING_CURRENTNESS_HTTP_PROOF_PATH` to an output file and run `tests/gaming-hybrid-lifecycle.integration.test.ts`. Only the named successful registry-directed fixture writes that synthetic artifact.

## Negative control

A separate worktree at unchanged base `228291e7`, with only the new lifecycle test copied in, failed both selected regressions: the response lacks `continuationRequired`/`reviewedSources`; and index-only submission never acquires the required article. The repaired implementation passes both. Existing manually pre-supplied index/article tests were already passing on the base and did not expose the defect.

## Preview and SQL boundaries

The maintained Railway PR preview provides a credential-empty sealed component application and passive worker. Its existing Gaming fixture now additionally checks generic reviewed hints, missing official index/build/season/status continuation policy, conflict refusal, and spent-round denial. It does **not** expose the normal authenticated hybrid Actions or execute the full multi-request production workflow. The full network sequence above is local HTTP evidence; claiming it as a hosted workflow would be inaccurate. No unrelated preview infrastructure was expanded to bypass this boundary.

The final PR description records exact-head Railway deployment/verifier status and CI PostgreSQL results. Local PostgreSQL was not executed; the existing disposable PostgreSQL 18 CI job exercises the durable Gaming suite separately.

## Builder follow-up

After production deployment, refresh the existing Gaming GPT Action with `contracts/arcanos_gaming.openapi.v1.json` and replace its opt-in Hybrid instruction fragment with `docs/gpt/arcanos-gaming-hybrid.instructions.md`. Start a new chat and verify real Action sequencing. Preserve the existing GPT identity, authentication, Web Search setting, and unrelated instructions. No Builder change, production deployment, or merge was performed here.
