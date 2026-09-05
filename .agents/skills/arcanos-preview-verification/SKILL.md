---
name: arcanos-preview-verification
description: Verify ARCANOS Railway PR previews at an exact commit, including sealed component evidence and scoped teardown. Use for preview verification or an authorized preview lifecycle; ordinary PR review does not authorize creating a preview.
---

# ARCANOS preview verification

Use the repository's maintained preview controller and verifier. Derive current targets, request bounds, proof versions, and ownership rules from tracked code; do not reuse historical SHAs, deployment IDs, hostnames, request totals, or successful runs.

## Establish the scope and evidence

1. Read the selected checkout's `AGENTS.md`. Record its root, HEAD, tracked/untracked status, and worktrees. Preserve existing work; use a separate clean checkout of the exact PR head when the runner needs it.
2. Read current remote PR head and base SHAs, repository identities, target branch, draft/state, labels, and preview check/run state. A local tracking ref alone is not current remote evidence.
3. Identify which actions the user already authorized: inspecting an existing preview, creating/reconciling it, executing the sealed network probe, or tearing it down. Reuse session authorization. Before an additional external mutation, prepare the exact action and target for approval; do not interpret a review request as permission to label, dispatch, deploy, or delete. A preview lifecycle does not authorize production changes, merge, Builder reconciliation, database operations, or live-provider probes.
4. Read these current files, using targeted excerpts:
   - `.github/workflows/railway-pr-preview-lifecycle.yml` and `railway-pr-preview-run.yml` for event admission, trusted checkout provenance, jobs, and status reporting.
   - `scripts/railway-pr-preview-lifecycle.mjs` for target ownership, base isolation, deployment attestation, retry bounds, and cleanup.
   - `scripts/native-pr-preview-e2e.mjs` and `scripts/native-pr-preview-contract.mjs` for accepted arguments, exact response contracts, proof headers, and bounded evidence.
   - `docs/RAILWAY_DEPLOYMENT.md` for the native PR lifecycle and the distinction between the trusted verifier and supplemental PR-head coverage.

Prefer current source over older instructions or prose when contracts differ, and report a meaningful discrepancy before relying on affected evidence.

## Reconcile and verify an authorized preview

- The current controller admits opted-in, non-draft, same-repository PRs targeting `main` through the `railway-preview` label. Inspect existing state before triggering anything. Use the maintained workflow's existing wakeup or documented recovery event only when needed and authorized; do not create a second lifecycle or retarget local Railway links.
- Verify the trusted workflow revision and controller-owned environment identity. The controller must attest an isolated base, remove inherited source triggers, deploy the exact head worker-first, and verify each role's sole active successful deployment, manifest, domain, and readiness. Do not accept an arbitrary recent successful deployment as equivalent. Repository safeguards protect trusted PRs from accidental effects; untrusted/fork code needs provider-level secret isolation before it starts. Never run PR code in a process holding the lifecycle token or print environment values to establish isolation.
- Obtain both hosts and role deployment identities from the trusted lifecycle evidence, then independently match their current ownership and source commit. Public readiness alone proves served identity, not Railway control-plane ownership. Stop on ambiguous targets, drift, partial results, or a head change; refresh evidence and assess whether the existing scope covers a replacement run.
- The trusted workflow executes its own verifier against a clean PR-head checkout used as Git evidence. If the PR adds or changes assertions, run the reviewed PR-head verifier separately against those same confirmed hosts from a credential-free, clean exact-head checkout. Its result supplements the trusted run; it cannot create, own, or clean up a Railway environment.
- From that checkout, validate the no-network invocation first:

  ```text
  npm run railway:probe:native-pr -- --pr-number <N> --commit-sha <SHA> --web-base-url <confirmed-web-https-url> --worker-base-url <confirmed-worker-https-url>
  ```

  The runner requires canonical `origin`, matching HEAD, and no tracked or untracked changes. Store evidence outside its checkout. After target verification and within existing network authorization, add both `--execute --allow-network`. Preserve the current runner's request/time/response bounds and no-redirect behavior; do not replace it with production smoke or general E2E scripts. Inspect any fixed external canary included by the current contract before execution.
- Require the full executed result, current proof versions, web readiness, passive-worker readiness, worker denials, exact contract-asset comparison, and the verifier's reported assertions. A dry-run `PASS` with `executed: false`, a health response, or an older successful verifier does not prove current served coverage. Report failures and timeouts without substituting an unbounded retry or claiming partial results passed.

## Teardown and report

When teardown is included in scope, preserve the exact verified environment identity and former hosts, remove the opt-in label through the authorized path, and follow the trusted cleanup run. A failed, timed-out, partial, or drifted verification stops dependent verification or replacement deployment; it does not cancel already authorized cleanup of an independently verified owned environment. Recheck ownership before cleanup and stop deletion if the target is ambiguous. Confirm label absence, successful owned-environment cleanup and control-plane absence, then bounded no-redirect `/readyz` checks on both former hosts. Record actual statuses; former-host 404s supplement environment absence and do not prove it alone. Never adopt or delete a legacy or unrelated environment. If cleanup is outside scope, report the retained preview and its current state.

Refresh remote head/base, PR state and labels, checks, and relevant deployment or cleanup evidence before finishing. Tie every conclusion to the tested SHA and verifier revision. Report the workflow result, supplemental exact-head result if needed, evidence links, failed/skipped checks, and retained or removed resources.

Describe sealed results as credential-free served component evidence with synthetic data and a passive worker. Identify the boundaries actually exercised by current assertions. Do not promote that evidence to normal-route authentication, active queue/worker execution, real SQL atomicity, live Notion/provider behavior, production deployment, or booking quality. Cite the relevant focused tests or PostgreSQL CI separately when they cover a boundary that the preview does not.
