# Architecture

## Overview
Arcanos is split into a TypeScript backend and an optional Python daemon client. The backend is the source of truth for API, confirmation gating, and Railway deployment.

## Prerequisites
- Read `README.md` and `CODEBASE_INDEX.md` first.
- Familiarity with Express routing and OpenAI SDK usage.

## Setup
Primary backend flow:
1. `src/start-server.ts` validates env and starts server.
2. `src/server.ts` builds app, starts workers, and binds port.
3. `src/routes/register.ts` mounts all route groups.
4. `src/services/openai/*` handles OpenAI client and request flows.

## Configuration
Main config layers:
- `src/config/env.ts` (validated env access)
- `src/config/unifiedConfig.ts` (fallback and precedence logic)
- `src/config/index.ts` (runtime defaults and derived values)

## Run locally
Build and run backend:
```bash
npm run build
npm start
```

## Deploy (Railway)
Deployment control lives in:
- `railway.json`
- `Procfile`
- `docs/RAILWAY_DEPLOYMENT.md`

## Troubleshooting
- Routing ambiguity: inspect `src/routes/register.ts` mount order first.
- Unexpected model selection: inspect `src/config/unifiedConfig.ts` precedence chain.

## References
- `../src/start-server.ts`
- `../src/routes/register.ts`
- `API.md`
- `CONFIGURATION.md`
