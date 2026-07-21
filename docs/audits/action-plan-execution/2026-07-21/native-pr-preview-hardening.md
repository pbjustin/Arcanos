# Native Railway PR preview hardening

Status: **LOCAL IMPLEMENTATION — NO PUSH, PULL REQUEST, RAILWAY MUTATION, OR
MIGRATION AUTHORIZED**

Prepared from branch `codex/phase2e-pr-preview-hardening`, whose starting
commit was `366fb9f65e42a7ebfc75f011534a7815f781f148`.

## Decision

Railway's native pull-request environment may be used as a lower-friction
preview foundation, but it must be passive by default. The special
`environments.pr` deploy override starts:

```text
node scripts/start-railway-service.mjs --pr-preview-safe
```

The launcher accepts that mode only when Railway supplies all of the
following:

- an environment name matching `Arcanos-pr-<positive integer>` exactly;
- a non-empty Railway project ID; and
- a non-empty Railway environment ID.

Both the web and worker services then expose only `GET`/`HEAD` requests to
`/health`, `/healthz`, and `/readyz`. All other paths and mutating methods
return `404`.
The passive process does not import or start the ARCANOS application, worker,
CLI bridge, provider clients, database/Redis clients, schedulers, migration
runner, or executor.

## Why passive mode is required

Repository inspection established these facts:

- Railway automatically builds and deploys services in native PR
  environments.
- A normal worker launch forces `RUN_WORKERS=true`.
- Normal web startup initializes database schema and may perform startup
  probes.
- The existing preview isolation marker is intentionally opt-in and therefore
  cannot protect an automatically created environment before variables are
  reviewed.
- Railway's current config-as-code PR override supports build/deploy settings,
  not a PR-only variables map.

Consequently, copying a production-like base and starting the normal runtime
would create an avoidable interval in which inherited configuration could be
used. Passive mode removes that interval and does not require a temporary
Railway token or immediate operator action.

## Config contract

`railway.json` locks native PR deployment to:

- the passive launcher command;
- no pre-deploy command;
- no cron schedule;
- `/health` health checks;
- no automatic restart; and
- no retry count while restart policy is `NEVER`.

`npm run validate:railway` rejects a missing or weakened PR override and
rejects `environments.pr.variables`. No Phase 2E migration command is part of
the native PR deployment path.

The launcher also recognizes an exact native `Arcanos-pr-<positive integer>`
environment as passive without relying solely on Railway applying the special
start-command override. This is a second fail-closed boundary, not an active
preview escape hatch.

The repository's complete `railway.json` currently contains pre-existing
extension fields that Railway's published JSON schema does not recognize.
Removing or translating those fields could change existing deployments and is
outside this local hardening scope. The new PR fragment itself uses supported
deploy fields, and the runtime identity check preserves passive behavior if a
config override is ignored.

## GitHub pull-request workflow boundary

Three repository workflows could otherwise perform provider-backed or
source-mutating work automatically on a pull request. Their jobs are now
restricted as follows:

- ARCANOS PR Assistant: manual dispatch only;
- ARCANOS Code Analysis: manual dispatch only; and
- Auto Documentation: mainline push or manual dispatch only.

Ordinary offline pull-request checks, documentation audit, Codecov, and
non-provider review-comment automation remain available. Full-backend CI
startup uses the recognized mock key, `FORCE_MOCK=true`, and a loopback-only
OpenAI base URL so it cannot probe an external provider. Manual workflow
dispatch remains a separate operator action.

## What this preview proves

The default PR preview can prove:

- the exact branch builds in Railway;
- Railway can start both declared application services;
- passive service networking and health checks work; and
- opening the preview cannot itself initiate ARCANOS application, worker,
  provider, bridge, migration, or execution effects.

It does **not** prove:

- ARCANOS application startup;
- PostgreSQL or Redis connectivity;
- Phase 2E migration safety;
- authenticated HTTP or MCP behavior;
- ActionPlan execution ownership; or
- Python executor compatibility.

Those checks remain separate, explicitly armed preview gates. Gate R1/R2 and
the existing isolated environment are not replaced or declared complete by
this change.

Opening a draft pull request is still a publication and Railway-preview action.
It remains behind a separate gate even though the resulting native preview is
designed to be passive.

Before publication, Railway must separately prove that the native PR base is
the isolated preview environment, not production, and that sensitive variables
are sealed or absent. Railway creates a PR environment by copying its selected
base, including services, networking, and ordinary variables; build commands
run before this passive runtime launcher and may receive copied variables.
The publication gate must also verify private-only PostgreSQL/Redis topology
and zero unintended domains or TCP proxies. Passive runtime hardening does not
replace those control-plane checks.

## Local validation

- Focused launcher: 40/40 passed, including open-handle and non-disclosure
  checks.
- Railway configuration contract: 6/6 passed.
- Pull-request workflow safety: 5/5 passed.
- Type check, boundary checks, lint, build, Railway validation, YAML parsing,
  diff checks, and commit guard passed. Lint retained existing warnings and
  reported no errors.
- Full Jest sweep: 433 suites and 4,647 tests passed; four suites and six tests
  were skipped. One unrelated existing GPT-OSS migration-draft marker assertion
  failed; neither that test nor its guard implementation is changed here.

## Activation boundary for a later gate

A later proposal may activate a native PR environment only after it proves a
preview-safe base, fresh private data services, exact source commit, provider
isolation, scoped credentials, additive migration state, and executor-disabled
startup. No active-mode bypass is implemented here.

## Rollback

Before publication, restore the previous local state by reverting the scoped
hardening commits or deleting the unpushed branch. After a future PR is opened,
reverting the hardening commit restores the prior config; closing the PR and
removing its Railway environment are separate operations and require their own
authorization. No database rollback is associated with passive mode because
it performs no database operation.
