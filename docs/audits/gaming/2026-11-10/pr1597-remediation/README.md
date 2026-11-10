# PR #1597 adversarial remediation

Original base: `2df6e6a0fb409aaa42e1b5f687ea2622c8dde560`.
Starting head: `ab8380e70116a50a0bfb524820cb97abdec3ccf4`.
Both matched the fetched PR, without SHA drift. This supplements the
[original acceptance record](../../2026-11-09/guide-answer/README.md).

The later [CodeRabbit follow-up](coderabbit-followup.md) narrows an overbroad
first-phase/form scope check and corrects receipt typography. Counts and hashes
below describe the preceding remediation; its historical receipts remain intact.

## Confirmed defects and bounded corrections

1. The purpose-clause predicate accepted a topic before a comma without requiring
   an action after it. The three supplied non-procedural controls passed source
   identity and source CLEAR and incorrectly reached generation in authenticated
   authored-fixture workflows. Their repaired coverage fails before generation.
   This proves a deterministic admission defect, not a live-provider exploit.
2. Imperative topic-by-gerund and purpose-colon instructions were rejected.
   The shared bounded action predicate now accepts these affirmative forms and
   rejects their question, passive, negative and unrelated-topic counterparts.
   Attributable negative advice remains evidence without affirmative support.
3. First-N-action presentation stripping erased factual quantities. Coordinated
   material-location questions lost their material referent. Requirements now
   retain explicit counts, action intent and separate material/location relations.
   Closed same-sentence references are resolved; absent subjects and cross-sentence
   pronouns fail with clarification. Literal acquisition titles remain atomic.

Actual selection also dropped an acquired Choose/Register continuation from a
counted procedure. Scoped counted continuations now use the existing
four-successor bound. Paragraph boundaries survive CLEAR attribution, and each
new starting anchor begins its own route. Counts cannot pool alternative routes,
unrelated paragraphs or structural rows. Required material locations must cover
the acquired material list; incidental topics and qualified subsets cannot prove
all materials are available at a location.

No public schema, plugin tool, acquisition/parser budget, source-authority gate,
OAuth behavior, workflow TTL/round limit or provider policy changes. Partial
answers remain a separate contract follow-up; incomplete coverage stays false.

## Reproduction and proof boundaries

Use Node `24.18.1` and npm `11.16.0`, with built shared packages:

```powershell
node scripts/run-jest.mjs --runTestsByPath tests/gaming-procedure-grammar.test.ts tests/gaming-request-factual-clauses.test.ts tests/gaming-guide-answer-delivery.integration.test.ts tests/gaming-guide-request-selection.test.ts tests/gaming-discovery-request-framing.test.ts --coverage=false --runInBand
```

For failing-before receipts, the final new regression files were copied into an
isolated detached worktree at the exact starting head. Its production source diff
remained empty. Run the same explicit test paths there after building packages.
The [sanitized application receipt](delivery-regressions.json) and
[application explanation](delivery-regressions.md) distinguish source acceptance,
selection, coverage, synthetic Trinity stages and final audit behavior. New
grammar/material fixtures are independently authored, not publisher quotations.
The [regression receipt](regression-receipts.json) lists failing-before test names,
fixture hashes and final validation counts.

| Identical regression file | Exact starting head | Repaired source |
| --- | --- | --- |
| Procedure grammar (53 cases) | 23 pass, 30 fail | 53 pass |
| Factual clauses (31 cases) | 21 pass, 10 fail | 31 pass |
| Authenticated delivery (24 cases) | 17 pass, 7 fail | 24 pass |

Independent reviewers inspected the original-base-to-starting-head diff and all
remediation source/callers/tests. They approved these canonical TypeScript AST
digests before updating the existing semantic pins:

| Reviewed file | AST SHA-256 |
| --- | --- |
| gamingRetrievalPolicy.ts | `a918c449c560c79d6c8204bebd1b6c795f0c17ee8b557e95e5d4aed48700dc09` |
| gamingClearEvidence.ts | `4f09281c9dfde0e51df902bc6c106dcabb27a10d77b71d67f7dff0af03002689` |

## Retained public Frontier evidence

The independent review replayed the real retained 5,488-character extraction
whose SHA-256 is
`7b650756e8a6f76016102e13a350d0c4b1ef5cdfe3a75f0977e7b8d5d5963367`.
It did not reacquire the page, renew authority or workflow TTL, or call a model.
The source and acquisition evidence remain in the
[historical diagnosis](../../2026-11-09/guide-answer/frontier-diagnosis.md).

| Question | Selected passages | Coverage | Context characters |
| --- | --- | --- | --- |
| Original prerequisite/starting question | 2 | Complete | 1,886 |
| Short starting question | 1 | Complete | 991 |
| Explicit first-three-action question | 1 | Incomplete | 893 |

All selected spans bind to retained acquired source text and its original URL.
The explicit count limitation is conservative: a passive publisher sentence
describing the map being presented stops the affirmative action chain. Extraction
retained that sentence intact. This does not establish that the guide lacks the
steps and must not be reported as complete three-action support.
The [replay receipt](frontier-selection-replay.json) contains source/span hashes
and the reviewed core digests without reproducing the publisher's article.

Selector-only replay timings, 31 samples after three warmups: original request
p50/p95 **11.257/12.638 ms**, short **5.900/6.345 ms**, counted incomplete
**5.894/7.317 ms**. Bounded request-policy probes measured **0.462/0.655 ms**
for 7,958 characters and **5.059/5.681 ms** for 8,000 repeated-clause characters.
These are local measurements, not acquisition/generation/end-to-end percentiles.
No paid model usage or cost was incurred by this remediation. Live acquisition
rate, grounded-answer rate, model cost and real end-to-end latency remain unproven.

## Validation and remaining acceptance

The complete affected Gaming sweep passed **240 suites / 8,640 tests**, with no
failures or skips. The final alternative-route test was added after that sweep;
the final focused run passed **seven suites / 185 tests**, including that control
and lifecycle/cancellation tests, with zero open handles. No runtime source
changed between these runs. Seven guarded PostgreSQL suites cover **167 distinct
passing tests** with zero skips and false authority **0/9**. The first combined
attempt had 166 passes and one compiled HTTP harness timeout; that unchanged
suite passed both cases in isolation after the broad sweep ended. The initial
failure remains in the SQL receipt, and its exact environmental cause is not
claimed proven. No timeout or operational limit was increased. All owned Gaming
schemas were removed, the owned loopback server was stopped, and prior clusters
were untouched.

Build, type-check, lint, backend/CLI contract and
offline validators, maintained documentation/index checks and production npm
audit passed. Lint retains 77 existing warnings and zero errors. Offline preview
security tests passed 16/16. The separate unchanged CI-range scanner harness
fails on this Windows host (8 pass, 4 fail); its extensionless executable stub
cannot run as a native executable, and side-history fixture checkout state is
platform-sensitive. This is not a claim that the harness passed.
The exact `ab8380` rerun also produced 8 passes and the same four failures;
both scanner scripts are byte-identical. Independent diagnosis established
Windows `ENOENT` for the extensionless stub and an ambient `core.autocrlf=true`
versus isolated Git-configuration mismatch in the long-history fixture.

Additional reproducible gates (run separately from service startup):

```powershell
npm run build
npm run type-check
npm run lint
npm run validate:backend-cli:contract
npm run validate:backend-cli:offline
npm run sync:check
npm run docs:check
npm run docs:links -- --local-only
npm run test:live-pr-preview:offline
npm audit --omit=dev --json > npm-audit.json
node scripts/check-npm-audit.js npm-audit.json
node --test scripts/ci-gitleaks-range.test.mjs
```

The last command has the inherited Windows result documented above. The
production audit policy reported zero actionable vulnerabilities. Staged commit
guard and native gitleaks scans cover the published patch independently of that
synthetic scanner harness.

Real repaired-head provider acceptance is **BLOCKED**: no authorized
non-production target serving this source with Gaming OAuth and a model budget
is available. Additional paid calls, production deployment/settings changes,
merge and a new CodeRabbit review are outside this mission. Exact-head CI is
snapshotted after publication without waiting for completion. Code readiness,
live acceptance and merge readiness remain separate conclusions.
