# Elite Dangerous live-validation preparation

This preparation receipt records the validation-only changes following reviewed
head `df0fb0b4d086c80c98fd99f884062bd413bbb4ac`. It is not a live-provider PASS.
Execution evidence is retained outside the checkout so recording it does not
change the exact candidate SHA being tested.

## Existing target and execution boundary

The existing `live-validation` environment contains only **ARCANOS V2 Validation**,
with one replica, restart policy `NEVER`, no shared variables, volumes, database,
Redis or TCP proxy. Its dedicated provider key is reused with the owner's explicit
choice. Production credentials are not copied. The existing reviewed target is
tighter than the facility defaults: **USD 2.00 conservative reservations, 31
provider requests including metadata, two workflows and 600 seconds**, with one
concurrent request, zero automatic retries and the existing 4,096-output-token
ceiling. Configured-rate cost estimates are not a provider invoice.

The maintained controller requires a separate Railway project token scoped to
this environment, successful exact-head `All Checks Complete` and `docs:check`,
ten genuine offline gate records, and matching source/tree/compiled/deployment
proof. None of those gates is bypassed. An older active validation deployment
must be separately retired within this isolated setup scope before the controller
can create and own its new deployment; it must never be adopted as this run.

This facility directly invokes the real hybrid-v2 backend workflow. It can prove
protected public acquisition, independent identity/applicability/CLEAR, selection,
coverage, real Trinity stages and mandatory final audit. Installed Gaming MCP
OAuth and frontend discovery remain separate evidence requirements.

## Profile and answer-retention changes

The canonical positive profile now asks the original system-colonisation
prerequisite/first-steps question and submits
`https://www.elitedangerous.com/news/system-colonisation-guide`. Publisher
reachability is unverified until execution; acquisition failures cannot become
successful grounding. Intake, reasoning and final stages remain required.

The exact question is classified as stable mechanics by the existing freshness
policy. Its expected semantic gap is `NONE`; no current-patch assertion or
fabricated uncertainty warning is added. The existing authored Samurai profile
and its four-clarification/advisory-freshness regressions remain covered. The
negative canonical profile is explicitly an authored wrong-game Sekiro fixture
and must consume zero provider calls.

The validation adapter previously discarded the actual audited answer before
the authenticated response. It now creates a closed `privateAnswer` only after
the original bound-audit and exact-final-response acceptance checks pass. The
runtime exposes it only to the existing authenticated exact-run acceptance
response after profile/evidence verification and credential-content screening.
The controller rechecks canonical answer hash, usable document hashes, source
ordering and citation indices, then uses its existing protected writer for
`accepted-answer.private.json` in the outside-checkout `0700` operator directory
with `0600` file permissions. Public summaries retain only the answer-payload
hash. Public evidence, observations, logs and failure projections exclude prose,
provider bodies, source passages and credentials. No endpoint, public Gaming
schema, installed plugin tool or source-authority rule changes.

## Reproduction and validation

- Same finalized adapter tests on exact reviewed source: **58 pass / two fail**
  because both accepted positives lack `privateAnswer`; after: **60/60 pass**.
- Services/controller POSIX regression set: **151 pass / 41 fail** before the
  feature and **192/192 pass** after. Those failures demonstrate unavailable
  retention/validation behavior, not 41 distinct pre-existing vulnerabilities.
- Composed HTTP contract fixture: **one fail** with the previous Samurai
  observation; **one pass** after adapting its authored fixture to canonical Elite
  semantics and private retention. Existing auth, usage and cleanup controls stay.
- A fresh LF Linux snapshot with every changed Git blob matching the Windows
  source passes **277/277** full live-validation offline tests and **16/16** preview
  verifier tests. Running against CRLF Dockerfiles in the Windows-mounted tree
  produced bootstrap-text failures; the Linux checkout resolves them without
  changing those tests or Dockerfiles. This snapshot is precommit evidence,
  separate from the final exact-SHA build attestation.
- Focused Gaming delivery/request/adapter/intake checks: **six suites / 245 tests**
  pass. Canonical build, type-check, lint, maintained documentation/local links and
  generated-index checks pass; lint retains zero errors and 77 existing warnings.

Reproduce with the pinned Node 24.18.1/npm 11.16.0 toolchain:

```sh
npm run test:live-validation:offline
npm run test:live-pr-preview:offline
node scripts/run-jest.mjs --runTestsByPath tests/live-validation-gaming-adapter.test.ts tests/trinity-gaming-intake.test.ts tests/gaming-guide-request-selection.test.ts tests/gaming-guide-answer-delivery.integration.test.ts tests/gaming-request-factual-clauses.test.ts tests/gaming-procedure-grammar.test.ts --coverage=false --runInBand
```

The maintained [live-validation runbook](../../../../LIVE_VALIDATION.md) defines
the exact-SHA bootstrap, paid admission, usage readback and scoped cleanup. A real
result must distinguish the public Frontier acquisition from the authored negative
control and preserve any failure rather than substituting synthetic success.

## Additional prerequisite-question regression

Independent review of `3500868f7bf26d28813764a07d8c68c5e8c31217` reproduced an
unanswered question being counted as prerequisite support. The authored accepted
passage `Does system colonisation require a permit?` passed the requirement
predicate, actual passage selector, request coverage and CLEAR claim-support
gate. The same question without its final question mark also passed. This is
accepted-passage proof, not an independently acquired publisher or live-model
exploit.

The correction excludes question sentences and the proven leading `Does` form
only from prerequisite support. It preserves independently stated requirements,
explicit absence of prerequisites, affirmative `Do ... only if ...` instructions,
negative gameplay advice and an affirmative answer following a question. Global
claim attribution, source authority and coverage thresholds remain unchanged.

The finalized 50-case factual-clause suite reports **45 pass / five fail** on the
unchanged starting source; after the correction, five focused suites report
**180/180 pass**, zero skips and zero open handles. The five former failures cover
four punctuated question forms and the same unpunctuated `Does` frame. Every
negative checks the predicate, actual selection/coverage and raw/selected CLEAR;
positive controls retain their citation relationship. No real-provider call was
made for these fixtures.

The complete affected Gaming run passes **240 suites / 8,662 tests**, with zero
failures, skips or open handles. The guarded durable-retrieval PostgreSQL suite
passes **29/29** on a newly created local PostgreSQL 18.6 target. Its schemas and
sessions were checked, the owned server was stopped and its listener was verified
absent. Build, type-check, lint, backend/CLI contract/offline checks, Railway static
validation and maintained documentation checks also pass on the repaired source.

The separate local operator launcher has twelve passing offline safety tests and
a nonpaid real-child startup check. Its temporary process uses an immutable
bundle, a clean environment, UID/GID 65534 and authenticated loopback HTTP. Those
checks establish local setup only. Actual paid execution remains gated by fresh
exact-head CI and the ten verified offline records; it must not be reported as
Railway hosting, installed MCP authentication or frontend discovery proof.
