# Draft pull request

## Suggested title

`feat(action-plan): prepare cumulative Phase 2A–2E preview candidate`

## Suggested body

### Overview

Prepare the cumulative Phase 2A–2E security and ActionPlan work for review and
a safe Railway-generated PR preview. This is a cumulative branch, not an
isolated PR-preview patch: it includes the credential contract, CLEAR decision
integrity, cross-language parsing, lifecycle guards, execution ownership and
result protocol, additive migration artifacts, Gate R tooling/evidence, and
the final native-preview hardening.

Native PR environments now start both declared application services in a
passive health-only mode, so PR creation cannot start the backend, worker,
provider clients, bridge, schedulers, migrations, or ActionPlan execution.

### Scope

- Preserve and review the cumulative Phase 2A–2E implementation history.
- Add an exact `environments.pr` deploy contract in `railway.json`.
- Add fail-closed native PR identity validation in the Railway launcher.
- Serve only passive health/readiness responses in PR mode.
- Reject protected and mutating paths without importing the application.
- Make `npm run validate:railway` reject weakened PR settings.
- Keep provider-backed or source-mutating PR workflow jobs manually gated.
- Document the boundary between passive PR creation and a later armed preview.

### Security properties

- `--pr-preview-safe` is accepted only for `Arcanos-pr-<number>` with
  Railway-supplied project and environment IDs.
- Exact native PR environments enter passive mode even if Railway does not
  apply the special start-command override.
- Web and worker processes spawn no runtime child in passive mode.
- No pre-deploy migration or cron is configured.
- Both services use `restartPolicyType=NEVER` with no retry count.
- Responses contain fixed non-sensitive fields and `Cache-Control: no-store`.

### Validation

- [x] Focused launcher tests
- [x] Railway compatibility contract tests
- [x] Pull-request workflow safety contract tests
- [x] `npm run validate:railway`
- [x] `npm run type-check`
- [x] `npm run lint`
- [x] `npm run build`
- [ ] `npm test` — 433 suites and 4,647 tests passed; one unrelated existing
  GPT-OSS migration-draft marker assertion failed; four suites were skipped.
- [x] `npm run guard:commit`

### Deployment boundary

Opening this PR is expected to cause Railway to create and deploy a native PR
environment. That publication/deployment action is **not authorized by the
local hardening task** and requires a separate operator gate.

That gate must first prove that Railway uses the isolated preview environment
as the PR base, that sensitive variables are sealed or absent, and that copied
PostgreSQL/Redis services remain private-only with no unintended domain or TCP
proxy. The passive launcher starts only after dependency installation and
build, so it cannot by itself protect build-time access to variables inherited
from the selected Railway base.

Provider-backed PR assistant and code-analysis jobs are skipped on automatic
pull-request events. Auto Documentation is likewise prevented from writing or
pushing from a pull-request event. Offline CI and non-provider review checks
may still run normally; full-backend CI startup is pinned to mock mode with a
loopback-only OpenAI base URL.

The generated preview is passive only. It does not apply migrations, connect
the application to PostgreSQL/Redis, start a worker/executor, or validate
Phase 2E protocol behavior. Those remain later, explicit gates.

At preparation time the cumulative branch is 94 commits ahead of and 6 commits
behind `origin/main` (355 files changed relative to the merge base). Refreshing
against `origin/main`, resolving any integration differences, and rerunning the
relevant security/full suites are required before publication.

### Rollback

Revert the scoped PR-preview hardening commit. Closing the PR or deleting a
Railway PR environment is a separate infrastructure action and must be
authorized separately.

### References

- `docs/audits/action-plan-execution/2026-07-21/native-pr-preview-hardening.md`
- `docs/audits/action-plan-execution/2026-07-20/phase2e-cumulative-preview-gates-runbook.md`
