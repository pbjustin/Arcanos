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

## Setup
- Install Node dependencies with `npm install`.
- Build workspace packages before full backend validation with `npm run build:packages`.
- Build the full backend artifact with `npm run build` before deployment-oriented validation or startup checks.

## Validation
- For protocol-boundary or backend CLI changes, run `npm run build:packages` before `npm run validate:backend-cli:contract` and `npm run validate:backend-cli:offline`.
- Run focused Jest suites with `node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false`.
- Run the default TypeScript Jest sweep with `npm test` when focused suites pass and you need the broader Node-side check.
- Run unit tests with `npm run test:unit`.
- Run integration coverage with `npm run test:integration` when changes touch backend flows or adapters.
- Run type checks with `npm run type-check`.
- Run lint with `npm run lint`.
- Run `npm run validate:gpt:job-hardening` when changes touch `/gpt-access`, async job polling, or GPT job/result hardening.
- Validate the TypeScript/Python backend CLI contract with `npm run validate:backend-cli:contract` and `npm run validate:backend-cli:offline`.
- Use `npm run validate:all` for the full local readiness sweep before release-sensitive changes.

## Railway
- Confirm the linked project, service, and environment before release with `railway status` or `railway link`.
- Validate Railway compatibility with `npm run validate:railway`.
- Use `npm run railway:probe:async` and `npm run railway:probe:fast-path` when checking Railway job execution paths or investigating production path regressions.
- For release verification, use this order: `npm run build`, `npm run validate:railway`, `railway up`, `npm run railway:smoke:production`, then `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort`.
- Run the production smoke check with `npm run railway:smoke:production` when verifying a live Railway deployment.
- Run the post-deploy timeout watchdog with `npm run railway:alert:timeouts -- --since 15m --lines 500 --fail-on-budget-abort` after `railway up`.
- Deploy only after validation with `railway up`.

## Security
- Never log bearer tokens, OpenAI keys, Railway tokens, cookies, session IDs, database URLs, or passwords.
- Control-plane and job-result lookups for GPT access must use approved direct endpoints or local services, never `/gpt/:gptId`.
- Do not expose raw SQL, shell execution, arbitrary internal proxying, or destructive self-heal operations through GPT access routes.
- Keep `/gpt-access` as a control/read gateway; job, MCP, and database reads must not fall back to `/gpt/:gptId`.
