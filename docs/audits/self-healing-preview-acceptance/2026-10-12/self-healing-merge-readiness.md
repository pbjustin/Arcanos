# Self-healing merge-readiness assessment

PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Branch: `codex/targeted-security-healing-20261012`.
Initial inspected head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

**MERGE_READY: BLOCKED. LIVE_PREVIEW_ACCEPTANCE: BLOCKED.**

The exact-head PR preview is absent and its isolation cannot be proven. Local
regressions and ordinary CI cannot pass mandatory genuine-runtime gates. This
verdict is independent from GitHub's syntactic mergeability/check status and
does not establish production readiness.

| Gate | Result | Evidence / required environment |
| --- | --- | --- |
| PR_HEAD_IDENTIFIED | PASS | Authenticated GitHub metadata plus matching branch/ref. Final published head is recorded in the PR receipt. |
| PREVIEW_ENVIRONMENT_MATCHED | BLOCKED | Expected `pr-676861-1539` absent; successful candidate belongs to another branch/SHA. |
| PREVIEW_ISOLATION_VERIFIED | BLOCKED | No exact-head target on which service/credential/storage/queue isolation can be established. |
| HEALTHY_BASELINE_VERIFIED | BLOCKED | Local normal consumer passed; genuine Railway baseline NOT_RUN. |
| FAILURE_DETECTION_VERIFIED | BLOCKED | Deterministic local threshold/transport tests passed; genuine Railway detection NOT_RUN. |
| MITIGATION_AUTHORIZATION_VERIFIED | BLOCKED | Local HTTP/policy/actuator denial and approved dispatch passed; runtime authorization evidence unavailable. |
| MITIGATION_APPLICATION_VERIFIED | BLOCKED | Local same-process command and scoped actuator tests passed; actual preview application NOT_RUN. |
| TRINITY_CONSUMPTION_VERIFIED | BLOCKED | Real Trinity consumer exercised locally against synthetic provider; cross-service/live consumer NOT_RUN. |
| RECOVERY_VERIFIED | BLOCKED | Local post-action measurable verification passed; no live incident close or improvement evidence. |
| MITIGATION_ROLLBACK_VERIFIED | BLOCKED | Local TTL/rollback/replacement/restart passed; preview return to baseline NOT_RUN. |
| SERVICE_ROLE_BOUNDARIES_VERIFIED | BLOCKED | Local role suppression/manual ownership passed; no attested live role instances. |
| CONCURRENCY_AND_IDEMPOTENCY_VERIFIED | BLOCKED | Local duplicate/lease/owner tests passed; genuine storage contention and cross-service behavior NOT_RUN. |
| REGRESSION_TESTS_PASSED | PASS | Pinned-toolchain focused/local contract tests and static checks; exact commands/totals in regression report. |
| EXACT_HEAD_RETESTED | BLOCKED | Local source-head regression receipt is distinct; no final-head live preview exists to retest. |
| MERGE_READY | BLOCKED | Mandatory live identity/isolation/application/recovery gates remain blocked. |

## Defects repaired and fixtures

The regression report records failing-before-fix evidence for dispatched
actuator accounting, Railway target containment, and false recovery from empty
or stale request windows. Follow-up lifecycle fencing invalidates verification
for an expired, cleared or replaced Trinity command without claiming recovery
or rolling back another command. Contained provider timeout/503 fixtures,
actual same-process Trinity consumer assertions, scoped authorization/target
tests and a two-process restart fixture provide deterministic local coverage.

## Remaining blockers and risks

1. No owned exact-head normal-runtime Railway preview; no live recovery proof.
2. Trinity/controller state is process-local. A mitigation selected on a worker
   does not reach a separate web service. No distributed command delivery or
   controller arbitration was added as an unrelated redesign.
3. Web automatic suppression is intentional; dedicated durable job-runner
   startup does not start the canonical scheduler. Live ownership must identify
   which same-process consumer can actually use a controller command.
4. Diagnosis keys are types, not unique durable incidents. There is no durable
   incident-open/close lifecycle, active-command restoration or evidence of
   restart-safe exactly-once external effects.
5. Prompt-route mitigation has no TTL; successful policy remains active until
   explicit rollback/clear or restart. Trinity TTL does not reset every budget.
6. Local queue/Redis tests mock storage. Disposable CI storage tests supplement
   regression evidence but do not prove preview wiring or isolation.
7. A standard sealed preview's pure policy contract and passive worker cannot
   establish normal-runtime controller-to-consumer healing.

Recommended next action: authorize and identify an isolated normal-runtime
preview at the final PR head, verify role ownership and disposable resources,
then rerun all applicable live scenarios with correlated detection, authorized
effect, actual consumer, measurable recovery and rollback evidence. Keep this
PR open; do not merge, promote, enable auto-merge or modify production while
mandatory gates remain blocked.
