# Generic source benchmark

The benchmark is an offline regression and release gate for source admission,
scope, and selected evidence. It invokes `evaluateGamingHybridCandidates` and
the real protected resolver, extractor, CLEAR assessment, applicability, and
selection path. Only DNS and HTTP responses use deterministic transport fixtures.
It performs no live acquisition, provider call, durable storage, or production
operation.

## Corpus and labels

`tests/testUtils/gamingGenericBenchmarkFixtures.ts` defines benchmark version
`gaming-generic-benchmark/v1` and labels `source-ownership-labels/v1`. The initial
corpus has 140 candidate evaluations: 45 valid and 95 invalid. Each of three
unrelated known titles (Stardew Valley, Portal 2, Hades) and two invented,
unregistered titles (Lantern Vale, Orbit Orchard) receives the same 28 generic
transformations. Source layout families include article, magazine, wiki table,
JSON, and inaccessible transport responses.

Fixtures contain synthetic gameplay passages. Labels assert source ownership,
integrity, compatibility, and admissibility; they do not assert external truth
about real game mechanics. Unknown titles require acquired title and independent
body or intact gameplay-record agreement. A submitted name, URL, or publisher
claim provides no independent identity evidence.

The fixture's known/unknown label is a corpus designation, not an assertion of
registry membership. Both invented titles are unregistered at the tested
implementation. Future corpus review must recheck that invariant independently
of the unchanged source-admission labels.

The fixture author specified labels and rationales before corresponding algorithm
repairs; the separate source-scope audit and root agent reviewed the primary and
local ownership rules. Labels derive from
the task requirements, without consulting acceptance outcomes. This is internal
independent specification and review, not a blinded external human labeling
study. A label change requires documented policy evidence, a new label version,
and rerunning both baselines. Rejecting a failing fixture is not grounds for
changing its label.

Valid cases cover independently identified articles, nested intact records,
explicit comparisons, quotations, historical negations, navigation and recommendation furniture, related sections,
locally scoped mixed-game records, and large complete articles. Invalid cases
cover wrong primary subjects, source-global prose and structured contradictions,
contradictory whole-guide subjects, DLC and edition conflicts, platform conflicts,
identity supplied only by request hints, HTTP 403, partial records, malformed
JSON, source prompt injection, contradictory statistics, insufficient content,
and expired applicability. Selected-evidence sentinel checks detect contamination
by locally excluded foreign-game records and related recommendations.

## Measures and release gates

One source candidate evaluation is one observation. Acceptance means the
production evaluator produced an accepted internal candidate; it does not mean a
completed generated answer. Diagnostic coverage means an internal versioned
evaluation includes all nine stages, valid explicit statuses, stable reason
codes, a terminal candidate outcome, rejection reasons, and recovery eligibility.
Generation remains explicitly unevaluated in this candidate-only benchmark.
This shape/status/code coverage does not exhaustively test diagnostic privacy,
metadata bounds or every failure mode; the separate evaluation-contract and
security regressions remain required.
Known expired-applicability fixtures additionally require a freshness-stage
rejection with `NO_LONGER_EFFECTIVE`, so a generic selection rejection does not
satisfy their diagnostic coverage.

The valid denominator includes every fixture labeled valid, including failures.
The invalid denominator includes every fixture labeled invalid, including
inaccessible sources. False negative rate is rejected-valid / valid; false
positive rate is accepted-invalid / invalid. These are reported separately.
Diagnostic coverage uses all evaluated candidates as its denominator.

Engineering gates are valid acceptance at least 95%, invalid rejection at least
99%, and diagnostic coverage 100%. Independently of aggregate rates, any
security-critical invalid acceptance or selected-evidence contamination blocks
release. Identity laundering, source-global game contradictions, unauthorized
access, and source-instruction acceptance are security-critical cases.

`gamingGenericBenchmarkMetrics.ts` reports two-sided nominal 95% Wilson score
intervals with z=1.959963984540054. The fixed synthetic corpus is deliberately
stratified, and transformations repeated across games are correlated. These
intervals describe finite sample uncertainty under a binomial model; they cannot
establish population performance or universal acceptance/rejection targets.
Even perfect 45/45 valid acceptance has a Wilson lower bound of about 92.13%;
perfect 95/95 rejection has a lower bound of about 96.11%. More representative,
independently labeled samples and blinded review remain necessary for production
performance claims.

## Reproduction

Use the repository's pinned Node 24.18.1 and npm 11.16.0, installed development
dependencies, and current shared-package builds. Run from the repository root:

```bash
node scripts/run-jest.mjs --runTestsByPath tests/gaming-generic-benchmark.test.ts --coverage=false --runInBand
```

The single `GAMING_GENERIC_BENCHMARK_REPORT` line contains bounded version,
denominator, error, interval, and gate results. It contains no raw acquired
passage, URL, credential, or player information. Record the exact commit SHA and
dirty diff state with each run. To compare against an older commit while agents
edit concurrently, archive that exact commit into an isolated directory, copy
only the unchanged benchmark files, and use the same pinned toolchain and
dependencies. Never label a concurrent working-tree run as a pristine baseline.

## Results and remaining limits

The pristine baseline uses archived source commit
`200463b3aac65eb494f71d842c1e2b0378530bfb`, the unchanged final labeled corpus,
Node 24.18.1, and npm 11.16.0. The machine-readable result in
[benchmark-baseline.json](benchmark-baseline.json) records the corpus SHA-256.

| Measure | Pristine baseline | Integrated commit |
| --- | --- | --- |
| Valid accepted | 40/45 (88.89%) | 45/45 (100%) |
| Invalid rejected | 85/95 (89.47%) | 95/95 (100%) |
| False negative rate | 5/45 (11.11%) | 0/45 (0%) |
| False positive rate | 10/95 (10.53%) | 0/95 (0%) |
| Diagnostic coverage | 0/140 (0%) | 140/140 (100%) |
| Security-critical invalid accepted | 10 | 0 |
| Selected foreign or related sentinel | 0 | 0 |

The baseline rejects all five valid mixed-game local-record articles with
`GAME_MISMATCH`. It accepts all five contradictory whole-guide subjects and all
five title-only identity cases. Title-only cases duplicate the acquired title in
an H1 and provide no independently named game in gameplay prose; the duplicate
heading is not independent body identity. Nominal Wilson intervals are
76.50–95.16% for valid acceptance and 81.70–94.18% for invalid rejection.

The immutable implementation commit
`d566c5ccb6dff14a70885be1d2d66a89fe242af7` passes all five benchmark tests on
2026-10-10 using the same pinned Node 24.18.1 and npm 11.16.0 toolchain,
PowerShell 7.6.6, unchanged labels, and identical corpus. Valid
acceptance improves by 11.11 percentage points and invalid rejection by 10.53
points. Integrated nominal Wilson intervals are 92.13–100% and 96.11–100%,
respectively. [benchmark-integrated.json](benchmark-integrated.json) records the
exact implementation SHA, source tree, corpus hash, changed source-file hashes,
and immutable validation proof. HEAD remained identical before and after the
run; the source tree was `1e37f417aa907b9e9f9129264e03e3e895752a29`.

All 2,431 tracked files in `src`, `tests`, `packages`, `workers`,
`arcanos-ai-runtime/src`, and `scripts` retained identical SHA-256 fingerprints.
The sorted fingerprint manifest hash remained
`2fdcda11cd876fb6cf42decef2a106cbe06ed29438fac1baf2cdd5742b879105`.
The corpus hash remained
`319d39bea80fa09911514e63e78d3fc0ed066a44ea9dfb2eee1e4e31fcb27968`.
This direct Jest run performed no shared-package builds or source writes;
the later documentation update changes only this report and its result JSON.
The evaluated stack includes foundation commit
`11344a08973127fe99b6cf5fb17cd2c6f255b800` and corroboration/recovery commit
`c48c7e0093da72edbd388713b7e3a9ea952b1f6e`. This runtime retains the generic bounded
full-content identity contradiction scan and adds full-source applicability
metadata inspection without treating applicability as independent game proof.
Compared with the previously benchmarked
`c406fcb5e1362a1dba850c6e18f59d87065a6711` source, freshness inspection, registry
applicability helpers, the sealed source-graph pin, and a separate late-applicability
security regression file changed. The frozen benchmark tests, fixtures and labels
remained unchanged. The maintained 29 late-game and 51 late-applicability
regressions remain separate from these 140 candidate observations and do not
alter these denominators or prove universal security coverage. Their focused
results, the full suite and CI outcomes belong to the validation ledger.

The benchmark cannot verify publisher accessibility, paywalls or robots policy
across live publishers, parser robustness across the web, acquired factual truth,
Trinity generation, full workflow recovery budgets, PostgreSQL storage behavior,
or production readiness. Passing this fixed corpus does not establish coverage
of all security cases; additional source-security regressions remain separate
required evidence. Existing focused transport, workflow, private-plugin,
durable-storage, and generation tests remain separate required evidence.
