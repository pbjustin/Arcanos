# Self-healing merge-readiness assessment

PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Date: 2026-10-12. Branch: `codex/targeted-security-healing-20261012`.
Initial inspected head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

**MERGE_READY: BLOCKED. LIVE_PREVIEW_ACCEPTANCE: BLOCKED.**

The owner subsequently authorized preparing the recommended isolated profile.
This resolves the authorization to do that work; it does not supply a platform
credential. Railway CLI returned Unauthorized, the connected tools cannot
create the required environment, and the existing trusted-main profile still
cannot consume a PR-only change. The [concrete provisioning proposal](self-healing-preview-provisioning-plan.md)
and local planning/attestation contract are prerequisites, not a deployed
profile or live acceptance. No live gate changes as a result of authorization.

Recovery head lock: `2fd4cf81833ba3be4592654bc7789dd3309374d7`.
Root cause: missing opt-in, proven by the lifecycle `not-opted-in` receipt.
Provisioning stopped before mutation: fixed service IDs are shared with
production and prohibited as targets by this mission; the managed profile is
sealed/passive and cannot run the normal runtime or PG/Redis. An owner-installed
trusted normal-runtime profile with preview-exclusive identities is required.
No new source defect was inferred from this intentional policy boundary.

Subsequent PR CI at the evidence-only C32 head failed one unchanged heavy
structured-evidence success test at its five-second default. Commit
`6f58e16af9a0e202d7415942a2a7d8870db131dc` gives only that case a bounded
30-second budget; assertions and runtime behavior are unchanged. Four covered
focused suites passed 32 cases with zero skips. Final-head full-CI status is
recorded separately on the PR; the failed C32 run is preserved in the regression
report. This correction does not lift any live provisioning or acceptance gate.

The exact-head PR preview is absent and its isolation cannot be proven. Local
regressions and ordinary CI cannot pass mandatory genuine-runtime gates. This
verdict is independent from GitHub's syntactic mergeability/check status and
does not establish production readiness.

| Gate | Result | Evidence / required environment |
| --- | --- | --- |
| PR_HEAD_IDENTIFIED | PASS | Authenticated GitHub metadata plus matching branch/ref. Final published head is recorded in the PR receipt. |
| PREVIEW_PROVISIONING_ROOT_CAUSE_IDENTIFIED | PASS | Exact lifecycle receipt: `action: noop`, `reason: not-opted-in`; supported-profile/production-ID conflict independently inspected. |
| PREVIEW_ENVIRONMENT_MATCHED | BLOCKED | Expected `pr-676861-1539` absent; successful candidate belongs to another branch/SHA. |
| PREVIEW_ISOLATION_VERIFIED | BLOCKED | No exact-head target on which service/credential/storage/queue isolation can be established. |
| WEB_AND_WORKER_DEPLOYED | BLOCKED | No compliant preview-exclusive identities; no deployment attempted or successful deployment IDs. |
| HEALTHY_BASELINE_VERIFIED | BLOCKED | Local normal consumer passed; genuine Railway baseline NOT_RUN. |
| FAILURE_DETECTION_VERIFIED | BLOCKED | Deterministic local threshold/transport tests passed; genuine Railway detection NOT_RUN. |
| MITIGATION_AUTHORIZATION_VERIFIED | BLOCKED | Local HTTP/policy/actuator denial and approved dispatch passed; runtime authorization evidence unavailable. |
| MITIGATION_APPLICATION_VERIFIED | BLOCKED | Local same-process command and scoped actuator tests passed; actual preview application NOT_RUN. |
| TRINITY_CONSUMPTION_VERIFIED | BLOCKED | Real Trinity consumer exercised locally against synthetic provider; cross-service/live consumer NOT_RUN. |
| RECOVERY_VERIFIED | BLOCKED | Local post-action measurable verification passed; no live incident close or improvement evidence. |
| MITIGATION_ROLLBACK_VERIFIED | BLOCKED | Local TTL/rollback/replacement/restart passed; preview return to baseline NOT_RUN. |
| SERVICE_ROLE_BOUNDARIES_VERIFIED | BLOCKED | Local role suppression/manual ownership passed; no attested live role instances. |
| CONCURRENCY_AND_IDEMPOTENCY_VERIFIED | BLOCKED | Local duplicate/lease/owner tests passed; genuine storage contention and cross-service behavior NOT_RUN. |
| RESTART_SAFETY_VERIFIED | BLOCKED | Prior two-process local invalidation passed; genuine preview restart NOT_RUN. |
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
8. The new prohibition on production service IDs rejects the existing managed
   lifecycle's fixed app IDs. Its trusted-main profile cannot be changed by a
   PR-only patch; manual replacement provisioning would bypass its ownership
   and cleanup contract. Required owner action is specified in preview evidence.

Recommended next action: install the reviewed trusted normal-runtime profile
with preview-exclusive app/storage identities and scoped authority, then
identify its isolated preview at the final PR head, verify role ownership,
then rerun all applicable live scenarios with correlated detection, authorized
effect, actual consumer, measurable recovery and rollback evidence. Keep this
PR open; do not merge, promote, enable auto-merge or modify production while
mandatory gates remain blocked.
