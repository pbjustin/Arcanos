# ARCANOS GPT Access Gateway

The GPT access gateway exposes scoped, authenticated, read-only backend/control-plane access under `/gpt-access/*`. It is intentionally separate from `/gpt/:gptId` so job result lookups and runtime inspection do not enter the writing plane guards.

## Production URL

Base URL:

```bash
https://acranos-production.up.railway.app
```

OpenAPI document for Custom GPT Actions:

```bash
GET https://acranos-production.up.railway.app/gpt-access/openapi.json
```

Use bearer authentication:

```bash
Authorization: Bearer <ARCANOS_GPT_ACCESS_TOKEN>
```

## Local Setup

```bash
npm install
npm run build:packages
```

Set a local gateway token before running route tests or a local server:

```bash
export ARCANOS_GPT_ACCESS_TOKEN="$(openssl rand -base64 48)"
npm run dev
```

On PowerShell:

```powershell
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$env:ARCANOS_GPT_ACCESS_TOKEN = [Convert]::ToBase64String($bytes)
npm run dev
```

Optionally restrict gateway operations with a comma-separated scope list:

```bash
ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read
```

## Validation

Run the focused gateway suite:

```bash
node scripts/run-jest.mjs --testPathPatterns=gpt-access-gateway --coverage=false
```

Run broader checks before release:

```bash
npm run type-check
npm run lint
npm test
npm run validate:railway
```

## Railway CLI Workflow

Confirm service and environment names before mutating anything:

```bash
railway status
# If not linked to the intended project/environment:
railway link
```

Install/check the CLI and login:

```bash
npm i -g @railway/cli
railway login
railway whoami
```

Set the gateway token in the intended environment only. Do not put the token in shell history, docs, source, or chat.

```bash
SERVICE="<SERVICE>"
ENVIRONMENT="<ENVIRONMENT>"
GATEWAY_CREDENTIAL="$(openssl rand -base64 48)"
printf "%s" "$GATEWAY_CREDENTIAL" | railway variable set ARCANOS_GPT_ACCESS_TOKEN --stdin --skip-deploys --service "$SERVICE" --environment "$ENVIRONMENT"
railway variable set "ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read" --skip-deploys --service "$SERVICE" --environment "$ENVIRONMENT"
railway variable list --service "$SERVICE" --environment "$ENVIRONMENT"
```

PowerShell:

```powershell
$SERVICE = "<SERVICE>"
$ENVIRONMENT = "<ENVIRONMENT>"
$bytes = New-Object byte[] 48
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$gatewayCredential = [Convert]::ToBase64String($bytes)
$gatewayCredential | railway variable set ARCANOS_GPT_ACCESS_TOKEN --stdin --skip-deploys --service $SERVICE --environment $ENVIRONMENT
railway variable set "ARCANOS_GPT_ACCESS_SCOPES=runtime.read,workers.read,queue.read,jobs.result,logs.read_sanitized,db.explain_approved,mcp.approved_readonly,diagnostics.read" --skip-deploys --service $SERVICE --environment $ENVIRONMENT
railway variable list --service $SERVICE --environment $ENVIRONMENT
```

Deploy after local validation:

```bash
railway up --detach --service "$SERVICE" --environment "$ENVIRONMENT"
railway logs --service "$SERVICE" --environment "$ENVIRONMENT" --since 10m --lines 100
```

Smoke test with the production token:

```bash
curl -sS https://acranos-production.up.railway.app/gpt-access/health \
  -H "Authorization: Bearer $GATEWAY_CREDENTIAL"
curl -sS https://acranos-production.up.railway.app/gpt-access/status \
  -H "Authorization: Bearer $GATEWAY_CREDENTIAL"
curl -sS https://acranos-production.up.railway.app/gpt-access/openapi.json \
  -H "Authorization: Bearer $GATEWAY_CREDENTIAL"
curl -i https://acranos-production.up.railway.app/gpt-access/status
```

Expected results: authenticated calls return JSON successfully, and the unauthenticated protected status call returns `401 UNAUTHORIZED_GPT_ACCESS`.

## Custom GPT Action Setup

Use the GPT Builder action schema URL:

```bash
https://acranos-production.up.railway.app/gpt-access/openapi.json
```

Configure authentication as API Key / Bearer and paste the token only into the GPT Builder authentication token field. Do not paste it into chat or store it in GPT instructions.

Add this GPT instruction:

```text
Use the ARCANOS GPT Access Gateway for backend diagnostics and operator workflows. For protected backend calls, use the configured Bearer authentication in the GPT Action. Never ask the user to paste the token into chat. Never route worker status, runtime inspection, queue inspection, MCP diagnostics, or job-result lookup through `/gpt/:gptId`; use `/gpt-access/*` action operations instead. For privileged operations, use the confirmation/operator gate first and execute only after explicit user approval.
```

## Safety Rules

- Do not route control-plane or job-result operations through `/gpt/:gptId`.
- Do not expose shell execution, raw SQL, arbitrary URL proxying, arbitrary internal path proxying, deploy/restart/rollback, or destructive self-heal actions through this gateway.
- Keep DB explain requests limited to approved templates and SELECT-only equivalents in production.
- Sanitize logs before returning them to a GPT Action.
