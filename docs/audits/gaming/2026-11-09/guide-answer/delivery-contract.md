# Guide answer delivery and partial coverage

The implementation baseline is `2df6e6a0fb409aaa42e1b5f687ea2622c8dde560`.
The new natural-language delivery regression uses the authenticated host-assisted
hybrid-v2 workflow. Its publisher documents, search results and model responses
are explicitly authored fixtures; they are not publisher captures or live
provider acceptance. Frontier acquisition has a separate [source receipt](frontier-diagnosis.md).

## Deterministic answer path

`tests/gaming-guide-answer-delivery.integration.test.ts` runs actual RSA/JWK OAuth
verification, Gaming MCP schemas and execution, host discovery handoff, URL-only
candidate submission, protected-reader boundaries, extraction, independent game
identity, CLEAR source/evidence policy, selection, mandatory request coverage,
Trinity intake/reasoning/final orchestration and the final answer audit. Only
external search/HTTPS/DNS/SDK calls, empty durable lookup and provider ingress
admission are controlled seams. Persistence is a forbidden sink.

The permanent five-scenario panel uses the assignment's normal player questions:

| Scenario | Acquired fixture support | Required answer checks | Live model |
| --- | --- | --- | --- |
| Elite Dangerous | An explicit prerequisite and ordered colonisation procedure | Selected passages, complete factual coverage, numbered instructions, unverified-applicability caveat and source binding | Not executed |
| Ocarina of Time | Early Deku Shield shop, location, price and purchase instructions | Claim-to-source citation, selected text and original question | Not executed |
| Elden Ring | Starting Samurai equipment, attributes, equipment load and actions | No later-story content, explicit unverified-current-patch caveat and retained spoiler policy | Not executed |
| Xenoblade Chronicles 2 | Separate Rex damage and Nia healing passages | Both role requirements and citations to their respective sources | Not executed |
| Ivory Clockwork | Independently authored unfamiliar game and invented rainwheel procedure | Original acquired objects and quantities survive; no model-knowledge substitution | Not executed |

The final-audit substitute independently checks actual returned answer text
against the selected chunk, source number, candidate URL, revision hash and
record ID. It rejects an invented numerical claim and a claim cited to the
other accepted source. This validates audit plumbing and enforcement; it does
not establish semantic performance of a real model.

The exact long Elite request and exact Rex/Nia request failed on the unchanged
baseline: sources were independently accepted but no evidence was selected,
coverage remained false, and no Trinity stage ran. The new tests preserve those
requests and require successful answer delivery. The identical final suite changes
from six passed/four failed at clean baseline source to ten passed/zero failed
after repair. The fourth baseline failure is a wrong-citation negative that
could not reach its audit until the Rex/Nia selection path was repaired.
Additional tests cover the
short Elite question, presentation wording, unsupported quantities and both
semantic-negative audits.

## Bounded measurements

The [sanitized fixture metrics](delivery-fixture-metrics.json) keep denominators
and individual scenario measurements. In the five-question panel, acquisition
is 6/6 both before and after, accepted-source selection changes from 3/6 to 6/6,
and complete coverage and delivered answers change from 3/5 to 5/5. The repaired
panel binds all seven expected claim citations. Delivered-claim citation accuracy
is 3/3 before and 7/7 after; unanswered questions do not count as wrong citations.

Local harness latency p50/p95 is 60.01/372.02 ms before and 72.67/388.54 ms after.
Acquisition is 7.09/23.25 ms and 7.27/24.32 ms; synthetic SDK-stage work is
3.35/15.21 ms and 4.54/15.18 ms. Five local cases with mocked external services
do not establish production percentiles or a performance gain. The repaired
panel executes 20 synthetic SDK responses rather than 12 because the two formerly
blocked questions now reach generation. Synthetic usage fields are fixture
constants. Real model usage, generation latency and cost remain unmeasured;
paid-provider calls and spending by this fixture are zero.

## PostgreSQL authority

The [guarded PostgreSQL receipt](postgres-authority.json) records seven suites
and 167 passed tests, zero failures, zero skips and zero open handles on a fresh
owned PostgreSQL 18.6 loopback cluster. The suites cover durable retrieval,
authority stamps and holds, historical restrictions, hybrid revocation, held-out
SQL selection and compiled authenticated MCP/queue/worker/fresh-process authority.
The existing nine held-out wrong-game/edition/platform/patch and authority
restriction cases accept zero false authorities. Their documents and grants are
authored; SQL and the production selection/authority implementations are real.

The compiled HTTP fixture uses the freshly built source and actual SDK/Trinity
transport against synthetic loopback publisher/search/model endpoints. Its
existing approximately 60-second admission-window wait is intentional test
behavior, not a guide-retrieval latency measurement. The fresh owned database
had zero remaining Gaming schemas after all suites. Only that owned server was
stopped; ignored cluster files were preserved. No configured application database
or production provider was used.

## Qualified partial answers

No partial-answer behavior is added. The existing hybrid-v2 contract has
`answer_ready`/`nextAction: answer`, mandatory `coverageSatisfied`, and
`requirementSupport` evidence links. It has no separate partial-answer state or
client acknowledgement for omitted factual requirements. Both selection passes
in `src/services/gamingHybridKnowledge.ts` stop before generation when coverage
is false, and the prepared generation request sets `requireRequestCoverage` to
true. `src/shared/gaming/gamingClearEvidence.ts` enforces that condition again.

Setting coverage true while omitting a prerequisite or quantity would misstate
authority. Returning an answer with coverage false would conflict with the
installed workflow's existing completion semantics. A partial-answer feature
therefore remains a separate compatibility follow-up requiring an explicit
contract and client behavior. Supported passages remain useful for the existing
bounded recovery, and unavailable facts must not be generated. The new required
quantum-crystal-quantity negative checks that generation stays uncalled.

Partial extraction is different from partial question coverage: an intact
passage may satisfy every requested fact even if unrelated publisher material
was outside extraction bounds. Such evidence must retain partial-extraction and
applicability qualifications through the existing audit.

## Live acceptance boundary

No authorized non-production endpoint serving this branch, Gaming OAuth
connection for that endpoint, or bounded paid-provider configuration was
supplied in the assignment. The installed Gaming plugin cannot be presumed to
address a non-production target. Its separately authorized [production baseline](production-baseline.json)
reproduces the unrepaired failure; it does not execute this branch.
The earlier PR #1595 [evidence index](../README.md) also records that its
non-production validation service used another branch. That is historical
context, not proof of current service state.

The five-scenario real-provider milestone is **BLOCKED**, pending a confirmed
non-production target and bounded provider run for the repaired SHA. HTTP 200,
source acceptance and deterministic Trinity transport are not substitutes for
the real player-facing answer acceptance. No deployment, production setting,
credential or durable source record is changed by this regression. The production
baseline stops before provider execution; the fixture suite spends no model calls.
