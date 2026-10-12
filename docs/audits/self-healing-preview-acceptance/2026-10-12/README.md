# PR #1539 self-healing preview acceptance

Date: 2026-10-12. Repository: `pbjustin/Arcanos`.
Branch: `codex/targeted-security-healing-20261012`.
Initial inspected PR head: `ec3ed16cb94c9166902bc810d0d73f89d322cf67`.

**LIVE_PREVIEW_ACCEPTANCE: BLOCKED. MERGE_READY: BLOCKED.**

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

Source SHA and final regression receipts are recorded in the regression report.
The final published PR head and its CI receipts are recorded in the PR
description and delivery report: a tracked artifact cannot embed the hash of
the commit that contains that artifact. Every head change invalidates earlier
exact-head live acceptance; this package contains no such passing result.
