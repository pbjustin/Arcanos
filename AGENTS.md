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

## Validation
- Run focused Jest suites with `node scripts/run-jest.mjs --testPathPatterns=<pattern> --coverage=false`.
- Run unit tests with `npm run test:unit`.
- Run type checks with `npm run type-check`.
- Run lint with `npm run lint`.

## Railway
- Confirm the linked project, service, and environment before release with `railway status` or `railway link`.
- Validate Railway compatibility with `npm run validate:railway`.
- Deploy only after validation with `railway up`.

## Security
- Never log bearer tokens, OpenAI keys, Railway tokens, cookies, session IDs, database URLs, or passwords.
- Control-plane and job-result lookups for GPT access must use approved direct endpoints or local services, never `/gpt/:gptId`.
- Do not expose raw SQL, shell execution, arbitrary internal proxying, or destructive self-heal operations through GPT access routes.
- Keep `/gpt-access` as a control/read gateway; job, MCP, and database reads must not fall back to `/gpt/:gptId`.
