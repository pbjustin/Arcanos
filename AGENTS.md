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
- Build workspace packages before full backend validation with `npm run build:packages`.
- Build the full backend artifact with `npm run build` before deployment-oriented validation or startup checks.

## Validation
- For protocol-boundary or backend CLI changes, run `npm run build:packages` before `npm run validate:backend-cli:contract` and `npm run validate:backend-cli:offline`.
- Run `npm run check:boundaries`, `npm run check:cef-layer-access`, and `npm run check:routing-boundaries` when changes affect protocol/layer boundaries or route handlers.
- Build worker artifacts with `npm run build:workers` when changes touch `workers/`, job runners, or worker startup paths.
- Run `npm run dist:check-aliases` when changes affect dist entrypoints, import rewrite behavior, or alias repair outputs.
- Run focused Jest suites with `node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false`.
- Run the default TypeScript Jest sweep with `npm test` when focused suites pass and you need the broader Node-side check.
- Run unit tests with `npm run test:unit`.
- Run integration coverage with `npm run test:integration` when changes touch backend flows or adapters.
- Run `npm run test:runtime-integration` when changes touch `arcanos-ai-runtime` integration behavior.
- Run `npm run test:all:stacks` when a change spans both the TypeScript workspace and `daemon-python`.
- Run type checks with `npm run type-check`.
- Run lint with `npm run lint`.
- Run `npm run validate:gpt:job-hardening` when changes touch `/gpt-access`, async job polling, or GPT job/result hardening.
- Validate the TypeScript/Python backend CLI contract with `npm run validate:backend-cli:contract` and `npm run validate:backend-cli:offline`.
- Run `npm run sync:check` when changes touch cross-codebase sync-enforced files shared with `daemon-python`.
- Use `npm run validate:all` for the full local readiness sweep before release-sensitive changes.

## Railway
- Confirm the linked project, service, and environment before release with `railway status` or `railway link`.
- Validate Railway compatibility with `npm run validate:railway`.
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
