# PR #1539 self-healing preview acceptance

## Current assessment — synthetic code verification

The owner explicitly deferred Railway live-service verification. The corrected executable and fixtures are `400be1912b9e429c9ea0ffdd8f0d07950a82d80c`; documentation-only head observed during preparation was `a7355c8cbe28ac5fdd285c45b031a4c07e416d22`. Final PR head/checks/reviews: [CI and review receipts](synthetic-ci-evidence.md): documentation head `a7355c8cbe28ac5fdd285c45b031a4c07e416d22`, CI/CD [38310400872](https://github.com/pbjustin/Arcanos/actions/runs/38310400872), required `docs:check` and `All Checks Complete` PASS; PR open/non-draft, CLEAN/MERGEABLE, zero unresolved threads. Final documentation-head receipts are linked in the PR description after fresh checks.. Full test and skip results: Full CI: 901 suites / 17,584 tests passed; 13 suites / 167 tests skipped. Complete local sweep: 899 suites / 17,540 tests passed; two suites / 44 assertions failed before PowerShell was available, all subsequently passed unchanged in two focused reruns (55 passed, two existing Windows-only skips). Repeated sweeps are not added as unique tests.. **Code MERGE_READY: PASS; LIVE_ACCEPTANCE: NOT_RUN — owner deferred.** A separate production deployment review is required; no verdict authorizes merge or deployment.

The final synthetic focused union passed **47 suites / 1,379 tests, zero skipped**, covering S01–S18 and A–E through actual controller, authorization, actuator, Trinity/SDK consumer, worker retry and fresh-process logic. This mission created no Railway resource, deployed no application and performed no production operation or paid provider call. The removed 108 preview planning/profile framework cases are intentionally retired infrastructure evidence, not missing normal-runtime recovery coverage.

Current evidence:

- [Synthetic verification and exact commands](synthetic-verification-report.md)
- [Preserved red-to-green regression evidence](synthetic-red-to-green-evidence.md)
- [Ownership and data flow](self-healing-architecture.md)
- [Eighteen-scenario matrix](self-healing-acceptance-matrix.md)
- [Live evidence scope and historical attempts](self-healing-preview-evidence.md)
- [Regression results](self-healing-regression-report.md)
- [Code merge readiness and residual risk](self-healing-merge-readiness.md)

Historical failed/blocked staging attempts are preserved below and in the existing evidence documents. They remain historical live failures/blockers and were not converted into successful acceptance. Process-local transient state and unverified production wiring/provider/database/Redis behavior remain operational risks.

---

## Historical live acceptance records — preserved

Everything below this divider records earlier preview/staging attempts and their policy at the time. Earlier live-gate blockers and merge verdicts are historical; they have not been rewritten into successful tests. The current assessment above uses the owner's explicit decision to defer live verification.

Date: 2026-10-12. Repository: `pbjustin/Arcanos`.
Branch: `codex/targeted-security-healing-20261012`.
Initial inspected PR head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

**LIVE_PREVIEW_ACCEPTANCE: BLOCKED. MERGE_READY: BLOCKED.**

The owner subsequently authorized preparation of the recommended isolated
profile. The [managed provisioning proposal](self-healing-preview-provisioning-plan.md)
records its exact resource scope and remaining execution boundary. Railway CLI
authentication is unavailable and the connected tools cannot create the required
environment. Local profile planning/attestation is separate from a provisioner,
runtime supervisor and live acceptance; no new environment was created.

Recovery follow-up: PR head `2fd4cf81833ba3be4592654bc7789dd3309374d7`
was revalidated open/non-draft. Missing opt-in caused `action: noop`,
`reason: not-opted-in`. Activating the current lifecycle is blocked under the
new mission: its fixed service IDs are also present in production, contrary to
the explicit prohibition on production service IDs as preview targets, and its
sealed/passive two-service contract cannot execute normal self-healing or
isolated PostgreSQL/Redis. No label, dispatch or Railway mutation was made.
See the updated preview evidence for the exact owner action and authority limits.

Full CI of the recovery documentation exposed one existing structured-evidence
success case exceeding its five-second test budget. The focused test-only
correction uses the existing bounded 30-second pattern and preserves all
assertions; four covered suites passed 32 tests. The regression report preserves
the failed C32 run and distinguishes it from the final-head CI receipt.

Read-only Railway discovery found no environment owned by PR #1539 and no
deployment matching its head. The successful deployment in `live-validation`
belongs to another branch and SHA. Isolation cannot be established for an
absent target. No live fault injection, runtime probe, Railway mutation,
production configuration change, promotion, merge or PR closure was performed.

The authorized fallback was local deterministic acceptance, focused repairs,
and this evidence package. Local integration exercises the real Trinity
consumer and OpenAI SDK against a contained synthetic loopback provider. It
does not establish genuine Railway recovery or real provider availability.

- [Architecture and ownership](self-healing-architecture.md), written before testing.
- [Fourteen-scenario acceptance matrix](self-healing-acceptance-matrix.md).
- [Railway identities and blocked preview evidence](self-healing-preview-evidence.md).
- [Regressions, fixtures, commands and test results](self-healing-regression-report.md).
- [Independent final gates and remaining risks](self-healing-merge-readiness.md).
- [Sanitized machine-readable evidence](self-healing-evidence.json).
- [Authorized managed-profile preparation](self-healing-preview-provisioning-plan.md).

Source SHA and final regression receipts are recorded in the regression report.
The final published PR head and its CI receipts are recorded in the PR
description and delivery report: a tracked artifact cannot embed the hash of
the commit that contains that artifact. Every head change invalidates earlier
exact-head live acceptance; this package contains no such passing result.
