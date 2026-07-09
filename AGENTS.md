# AGENTS.md

## Arcanos rules
- Protocol-first architecture
- TypeScript owns public protocol surface
- Python stays behind protocol boundary
- Schema-first changes only
- Small, reviewable commits
- Separate planning, execution, and mutation
- No privilege escalation across tools or environments
- Prefer deterministic JSON outputs
- Never route system operations through the writing pipeline

## Code Change Policy (Surgical Edits Only)

### Prime Directive

Solve the requested problem with the smallest safe change.

Assume the existing codebase structure is intentional. Do not redesign, reorganize, or refactor unless explicitly instructed.

---

### Required Behavior

* Make **surgical, minimal changes only**

* Preserve:

  * Architecture and file structure
  * Public APIs and contracts
  * Naming conventions
  * Formatting and style
  * Control flow and patterns already in use

* Match the surrounding code style, even if it is not ideal

---

### Strict Prohibitions

Do NOT:

* Perform broad refactors or rewrites
* Introduce new frameworks, libraries, or patterns without approval
* Rename files, functions, classes, variables, or exports unnecessarily
* Modify unrelated code
* Perform formatting-only or cleanup-only changes
* Change configs, lockfiles, migrations, or generated files unless required
* "Improve" code outside the scope of the task

---

### Before Making Changes

1. Identify the **smallest possible set of edits**
2. Prefer editing existing code over adding new abstractions
3. Reuse existing utilities and patterns
4. Avoid moving or restructuring code

---

### If a Large Change Seems Necessary

You MUST:

1. Stop
2. Explain why a minimal change is insufficient
3. Propose the smallest viable alternative
4. Wait for approval before proceeding

---

### After Changes

* Summarize:

  * What changed
  * Why it was necessary
* Call out:

  * Risks
  * Assumptions
* Keep explanations concise and focused only on the change

---

### Decision Rule

If multiple approaches are possible, choose the one that:

1. Produces the smallest diff
2. Minimizes risk of breaking existing behavior
3. Requires the fewest new concepts or changes

## Setup
- Install Node dependencies with `npm install`.
- Use `npm ci` for reproducible CI, Docker, or Railway-style installs when you are validating those environments rather than local development.
- Use `npm run probe` for a quick runtime/environment diagnostic before deeper startup or validation work.
- Use `npm start` to run the compiled backend entrypoint after a successful build or when validating production-style local startup.
- Use `npm run dev` for the full local TypeScript server bootstrap; it rebuilds packages/workers, repairs aliases, checks dist aliases, copies assets, and starts the server.
- Use `npm run dev:inspect` when debugging startup behavior with the Node inspector against the built backend entrypoint.
- Use `npm run dev:watch` for TypeScript watch-only iteration when you only need incremental compilation feedback without starting the backend.
- Build workspace packages before full backend validation with `npm run build:packages`.
- Build the full backend artifact with `npm run build` before deployment-oriented validation or startup checks.

## Validation
- Use `npm run start:worker` when validating local worker-only flows, async pipelines, or job runner startup behavior.
- Run `npm run self-test` when changes touch the self-test pipeline, `/devops/self-test`, or scheduled operational checks.
- Run `npm run daily-summary` after `npm run build` when changes touch daily summary generation or `/devops/daily-summary`.
- For protocol-boundary or backend CLI changes, run `npm run build:packages` before `npm run validate:backend-cli:contract` and `npm run validate:backend-cli:offline`.
- Run `npm run check:boundaries`, `npm run check:cef-layer-access`, and `npm run check:routing-boundaries` when changes affect protocol/layer boundaries or route handlers.
- Build worker artifacts with `npm run build:workers` when changes touch `workers/`, job runners, or worker startup paths.
- Run `npm run worker:jobs:maintenance -- inspect` when investigating failed worker jobs; use its `requeue` and `cleanup` modes only for explicit job-maintenance work against a configured database.
- Run `npm run dist:check-aliases` when changes affect dist entrypoints, import rewrite behavior, or alias repair outputs.
- Run focused Jest suites with `node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false`.
- Run the default TypeScript Jest sweep with `npm test` when focused suites pass and you need the broader Node-side check.
- Run unit tests with `npm run test:unit`.
- Run integration coverage with `npm run test:integration` when changes touch backend flows or adapters.
- Run `npm run test:all` when you need the combined root unit and integration Jest sweep.
- Run `npm run test:runtime-integration` when changes touch `arcanos-ai-runtime` integration behavior.
- Run `npm run test:all:stacks` when a change spans both the TypeScript workspace and `daemon-python`.
- Run type checks with `npm run type-check`.
- Run lint with `npm run lint`.
- Run `npm run job-events:timeline -- --job-id <id>` or `--trace-id <id>` when tracing async job-event ordering or debugging database-backed job history.
- Run `npm run mcp:stdio` when changes touch the MCP stdio transport or GPT fast-path MCP bridge.
- Use `npm run mcp:stdio:dev` for TypeScript-level MCP stdio iteration before validating the compiled entrypoint with `npm run mcp:stdio`.
- Run `npm run validate:gpt:job-hardening` when changes touch `/gpt-access`, async job polling, or GPT job/result hardening.
- Run `npm run gptoss:runtime:readiness`, `npm run gptoss:runtime:release-gate`, and `npm run gptoss:runtime:release-gate:ci` when changes touch the local GPT-OSS effective-router runtime, release evidence, or CI-safe release gating.
- Run `npm run gptoss:adapter:eval:dry`, `npm run gptoss:adapter:eval`, and `npm run gptoss:adapter:eval:effective-router:regress` when changes affect GPT-OSS adapter behavior, local evals, or effective-router regression baselines.
- Run `npm run gptoss:private-serving:design:validate`, `npm run gptoss:private-serving:threat-model:validate`, and `npm run gptoss:private-serving:scaffold:validate` when changes touch GPT-OSS private-serving design, boundary, or scaffold validation work; use `npm run gptoss:private-serving:scaffold:report` when you need the PR-style report artifact.
- Run `npm run gptoss:db:governance:validate` when changes affect GPT-OSS database governance schemas or export controls.
- Run `npm run guard:commit` when changes affect commit-guarded governance or release-readiness checks and you do not want to wait for the full `npm run validate:all` sweep.
- Validate the TypeScript/Python backend CLI contract with `npm run validate:backend-cli:contract` and `npm run validate:backend-cli:offline`.
- Run `npm run sync:check` when changes touch cross-codebase sync-enforced files shared with `daemon-python`.
- Use `npm run sync:watch` for ongoing cross-codebase sync monitoring, `npm run sync:fix` for the scripted sync-fix pass, and `npm run sync:setup` when restoring the auto-sync setup locally.
- Use `npm run converge:preview` to dry-run convergence checks and `npm run converge:all` or `npm run converge:ci` when working on convergence-plan criteria or artifact generation.
- Use `npm run validate:all` for the full local readiness sweep before release-sensitive changes.
- TODO: `db:init`, `db:patch`, `guide:generate`, `test:doc-workflow`, `audit:python`, `audit:python:fix`, and `sync:auto` remain listed in `package.json`, but the current checkout is missing one or more referenced script targets; treat them as unavailable until the targets are repaired or replaced.

## Railway
- Confirm the linked project, service, and environment before release with `railway status` or `railway link`.
- Validate Railway compatibility with `npm run validate:railway`.
- Railway deploys must start through `node scripts/start-railway-service.mjs`; keep `ARCANOS_PROCESS_KIND=web` on the API service, `ARCANOS_PROCESS_KIND=worker` on the worker service, and use `/health` as the Railway health check path.
- Use `npm run railway:probe:async` and `npm run railway:probe:fast-path` when checking Railway job execution paths or investigating production path regressions.
- For release verification, use this order: `npm run build`, `npm run validate:railway`, `railway up`, `npm run railway:smoke:production`, then `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort`.
- Run the production smoke check with `npm run railway:smoke:production` when verifying a live Railway deployment.
- Run the post-deploy timeout watchdog with `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort` after `railway up`.
- Use `npm run railway:alert:budget-abort` for the standard 15-minute post-deploy BUDGET_ABORT watchdog.
- Deploy only after validation with `railway up`.

## Security
- Never log bearer tokens, OpenAI keys, Railway tokens, cookies, session IDs, database URLs, or passwords.
- Control-plane and job-result lookups for GPT access must use approved direct endpoints or local services, never `/gpt/:gptId`.
- Do not expose raw SQL, shell execution, arbitrary internal proxying, or destructive self-heal operations through GPT access routes.
- Keep `/gpt-access` as a control/read gateway; job, MCP, and database reads must not fall back to `/gpt/:gptId`.
