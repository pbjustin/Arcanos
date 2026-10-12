# PR #1539 self-healing preview acceptance

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
