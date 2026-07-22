# Railway Redis lifecycle preview

**Status: PREPARED / NOT EXECUTED**

This runbook prepares an end-to-end proof that a temporary Redis outage does not remove the ARCANOS web listener and that Redis recovery restores readiness without restarting the web deployment. It must only target a new, empty, non-production Railway environment. Nothing in this document has been executed against Railway.

The evidence probe is read-only and dry-run by default. It never invokes Railway CLI, changes a service, reads Railway variables, or infers a target from the local Railway link or ambient environment variables.

## Safety contract

Do not proceed unless an operator has approved creation and later deletion of a billable preview environment.

- Create an **empty** persistent environment. Do not duplicate or fork the production environment.
- Use an environment named `arcanos-redis-lifecycle-preview-YYYYMMDD-N`. Native `Arcanos-pr-N` environments use the repository's passive PR-safe launcher and cannot exercise the application lifecycle.
- Add only one web service and one fresh Redis service. Do not add a worker, Postgres, executor, cron, or production volume.
- Do not copy production variables. In particular, do not provide production OpenAI credentials, GPT Access credentials, database URLs, Railway tokens, cookies, or shared secrets.
- Keep Redis private-network-only. The Railway Redis template enables a public TCP proxy by default; remove that proxy in the preview service's Networking settings before deploying the web service.
- Use `/health` as the Railway deployment healthcheck. `/readyz` is intentionally unavailable during the Redis outage and therefore must not be the deployment startup gate for this experiment.
- All Railway mutations below are separate operator gates. The evidence probe cannot perform them.

Railway environments and private networking are environment-scoped, but that isolation does not replace the identity checks in this runbook. Railway healthchecks gate deployment startup; they are not continuous monitoring, which is why the recovery proof uses the continuous local probe.

References: [Railway environments](https://docs.railway.com/environments), [private networking](https://docs.railway.com/networking/private-networking), [healthchecks](https://docs.railway.com/deployments/healthchecks), and [Redis](https://docs.railway.com/databases/redis).

## Prepared topology

| Role | Count | Network exposure | Data/credentials |
| --- | ---: | --- | --- |
| ARCANOS web | 1 | One temporary Railway HTTPS domain | Mock provider only; no production secrets |
| Fresh Redis | 1 | Railway private network only | Disposable preview data |
| Worker/Postgres/executor | 0 | None | None |

Required web variables:

```text
ARCANOS_PREVIEW_ISOLATION=true
ARCANOS_PROCESS_KIND=web
RUN_WORKERS=false
FORCE_MOCK=true
ALLOW_MOCK_OPENAI=true
OPENAI_API_KEY_REQUIRED=false
OPENAI_BASE_URL=http://127.0.0.1:9/v1
REDIS_URL=${{<PREVIEW_REDIS_SERVICE_NAME>.REDIS_URL}}
```

Railway supplies `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`, `PORT`, and the other platform identity variables. Do not override them. The loopback provider URL intentionally cannot reach a real provider; `FORCE_MOCK=true` keeps application behavior deterministic.

## Local preflight (no Railway access)

Run from the repository root at the exact commit intended for the preview:

```powershell
npm run build:packages
node scripts/run-jest.mjs --testPathPatterns=railway-redis-lifecycle-preview-probe --coverage=false
npm run validate:railway
npm run railway:probe:redis-lifecycle
```

The final command must print one report with:

```json
{
  "mode": "DRY_RUN",
  "target": null,
  "executed": false,
  "networkAttempted": false,
  "summary": { "status": "DRY_RUN" }
}
```

The complete output contains additional schema-required fields. Validate evidence against [`schemas/redis-lifecycle-preview-evidence.schema.json`](../schemas/redis-lifecycle-preview-evidence.schema.json).

## Gate 1 — create the isolated preview (held)

This gate is a Railway mutation and is **not authorized or executed by preparation of this runbook**.

1. In the Railway dashboard, create a new empty persistent environment in the intended non-production project. Name it with the required pattern, for example `arcanos-redis-lifecycle-preview-20260722-1`.
2. Record the project, environment, web service, Redis service, and later web deployment IDs. Compare every ID with the production inventory and stop if any ID matches.
3. Add a fresh Redis service to this environment.
4. Remove the Redis public TCP proxy in Networking. Confirm Redis has no public domain or TCP proxy before continuing.
5. Add one empty web service sourced from the exact reviewed repository commit.
6. Set only the variables listed above. Use a private Railway reference for `REDIS_URL`; never paste a Redis URL into the shell or evidence file.
7. Confirm the web deploy settings resolve to `node scripts/start-railway-service.mjs` and `/health`, as declared in `railway.json`.
8. Generate one temporary Railway HTTPS domain for the web service. Record only its origin, with no path, query, credentials, or fragment.

If CLI is preferred after the empty environment has been approved and created, use explicit IDs on every command and inspect `--help` for the installed CLI version first. The examples assume the current CLI's global project/environment selectors. If the installed command does not support every required selector, stop and use the dashboard against the recorded IDs; do not drop an identity flag or rely on the currently linked environment. Example command shapes, intentionally unexecuted:

```powershell
railway add --database redis --project <PROJECT_ID> --environment <PREVIEW_ENVIRONMENT_ID> --json
railway add --service "ARCANOS Redis Lifecycle Web" --project <PROJECT_ID> --environment <PREVIEW_ENVIRONMENT_ID> --json
railway up --detach --project <PROJECT_ID> --environment <PREVIEW_ENVIRONMENT_ID> --service <PREVIEW_WEB_SERVICE_ID>
```

Do not put secret values on a command line. Configure the allowlisted preview variables and the private Redis reference in Railway's variable UI.

## Gate 2 — validate the explicit target without network (held target)

Fill all placeholders from the newly created preview. Omitting either an identity or the phase fails closed. This command validates the target but does not make a request:

```powershell
npm run railway:probe:redis-lifecycle -- --target isolated-preview --base-url https://<PREVIEW_WEB_DOMAIN>.up.railway.app --environment arcanos-redis-lifecycle-preview-20260722-1 --environment-id <PREVIEW_ENVIRONMENT_UUID> --web-service-id <PREVIEW_WEB_SERVICE_UUID> --web-deployment-id <PREVIEW_WEB_DEPLOYMENT_UUID> --phase outage
```

Expected result: `mode=DRY_RUN`, `networkAttempted=false`, and check code `EXPLICIT_TARGET_VALIDATED_NO_NETWORK`.

The probe rejects:

- the known ARCANOS production origin and any Railway hostname explicitly labeled `production`;
- non-HTTPS targets, custom ports, credentials, paths, queries, and fragments;
- domains outside `*.up.railway.app`;
- environment names outside the isolated-preview pattern;
- malformed Railway resource UUIDs;
- partial target identity; and
- either live flag supplied without the other.

The evidence records its execution limits. The probe rejects more than 100 samples, intervals longer than 5000 ms, or request timeouts longer than 2000 ms so a nominally bounded run cannot be stretched into an ineffective outage check.

Because the probe intentionally has no Railway control-plane access, its environment/service/deployment IDs are operator-supplied attestations; public HTTP cannot prove that the domain resolves to those IDs. Before either live phase, independently confirm the domain-to-service mapping in the Railway dashboard or a read-only control-plane listing. The hostname and canonical-production denials are defense in depth, not a replacement for that check.

This probe proves listener, liveness, readiness, retry, and recovery behavior. It does not invoke an application business operation, so operation-specific fast-failure behavior remains covered by local adapter/route tests unless a separately reviewed, non-mutating preview operation is added.

## Gate 3 — prove outage behavior (held)

This gate contains two separately controlled actions.

### 3A. Stop only the preview Redis service

Confirm the preview environment ID and Redis service ID again. The held mutation is:

```powershell
railway down --project <PROJECT_ID> --environment <PREVIEW_ENVIRONMENT_ID> --service <PREVIEW_REDIS_SERVICE_ID> --yes
```

`railway down` removes the latest successful deployment for the selected service; it does not delete the service. See [Railway CLI `down`](https://docs.railway.com/cli/down).

If the web service has not yet been deployed, deploy the exact reviewed commit now while Redis remains down. This proves listener binding is independent of Redis startup. Record the resulting web deployment ID and use that same ID in every report.

### 3B. Capture read-only outage evidence

Live HTTP requests require both authorization flags. The probe performs five bounded samples by default:

```powershell
npm run railway:probe:redis-lifecycle -- --target isolated-preview --base-url https://<PREVIEW_WEB_DOMAIN>.up.railway.app --environment arcanos-redis-lifecycle-preview-20260722-1 --environment-id <PREVIEW_ENVIRONMENT_UUID> --web-service-id <PREVIEW_WEB_SERVICE_UUID> --web-deployment-id <PREVIEW_WEB_DEPLOYMENT_UUID> --phase outage --execute --allow-network
```

Acceptance criteria:

- `/health` and `/healthz` return 200 for every sample;
- every health/readiness response completes within the report's `limits.requestTimeoutMs` bound;
- both liveness payloads report `listener_bound=true`;
- `/readyz` returns 503 and its Redis check is unhealthy;
- the final health/readiness state uses `REDIS_DEPENDENCY_UNAVAILABLE`;
- liveness reports a scheduled Redis retry;
- the public responses contain no Redis URL, credential marker, or low-level connection error; and
- the report exits zero with `summary.status=PASS`.

Any 502, timeout, invalid JSON, listener ambiguity, readiness success during the outage, raw dependency detail, or missing retry is a failed proof.

## Gate 4 — prove recovery without web restart (held)

Use two terminals. Start the read-only recovery probe **before** the Redis mutation so it observes both sides of the transition.

Terminal A (bounded to 80 samples, one second apart by default):

```powershell
npm run railway:probe:redis-lifecycle -- --target isolated-preview --base-url https://<PREVIEW_WEB_DOMAIN>.up.railway.app --environment arcanos-redis-lifecycle-preview-20260722-1 --environment-id <PREVIEW_ENVIRONMENT_UUID> --web-service-id <PREVIEW_WEB_SERVICE_UUID> --web-deployment-id <PREVIEW_WEB_DEPLOYMENT_UUID> --phase recovery --execute --allow-network
```

After Terminal A has captured at least one degraded sample, Terminal B may perform the separately approved preview-only mutation:

```powershell
railway redeploy --project <PROJECT_ID> --environment <PREVIEW_ENVIRONMENT_ID> --service <PREVIEW_REDIS_SERVICE_ID> --yes
```

See [Railway CLI `redeploy`](https://docs.railway.com/cli/redeploy). Do not redeploy the web service.

Acceptance criteria:

- liveness remains 200 throughout the transition;
- both liveness payloads keep `listener_bound=true` and converge on Redis `ready`;
- `/readyz` is first 503 and later 200 in the same probe run;
- the final health state reports Redis `ready` with no dependency error code;
- the final Redis readiness metadata reports `recoveryCount >= 1`;
- web process uptime is monotonic and the process start time inferred independently from each server timestamp/uptime pair remains stable; and
- the report exits zero with `summary.status=PASS` and `readinessTransitionObserved=true`.

The supplied web deployment ID binds each report to the operator's intended target, but public HTTP cannot independently attest Railway deployment identity. Before and after recovery, use a read-only deployment listing or the Railway dashboard to prove that the active web deployment ID is unchanged. Save only the relevant IDs/status/timestamps; do not copy variables or logs containing secrets.

Example read-only command shape:

```powershell
railway deployment list --project <PROJECT_ID> --environment <PREVIEW_ENVIRONMENT_ID> --service <PREVIEW_WEB_SERVICE_ID> --limit 2 --json
```

The proof fails if the web deployment ID changes, web uptime resets, a new web replica replaces the sampled process, or Railway restarts the web deployment. If the platform runs more than one web replica, scale the preview web service to exactly one before testing so uptime has an unambiguous meaning.

## Evidence package

Keep the following reviewable artifacts together:

1. Exact Git commit SHA and local test/validation results.
2. Sanitized preview topology: project/environment/service/deployment IDs and service roles, without variable values.
3. Confirmation that the Redis TCP proxy was removed.
4. Outage probe JSON.
5. Recovery probe JSON.
6. Read-only before/after web deployment identity evidence.
7. Operator timestamps for preview Redis `down` and `redeploy` actions.
8. A final statement that production IDs were excluded and production was not modified.

Do not include raw Railway variables, Redis URLs, authorization headers, provider keys, database URLs, cookies, or unfiltered logs.

## Gate 5 — cleanup (held)

Cleanup is a final, separately authorized destructive action. Reconfirm the exact preview environment ID, archive the sanitized evidence, and then delete only the disposable preview environment through Railway's dashboard or the CLI command supported by the installed version. Never compute the deletion target from the current link, an environment variable, or a name glob.

After deletion, verify that the preview web domain no longer resolves and that the production environment, services, deployment IDs, and domains are unchanged.

**Current execution record: no Railway environment was created, no service was stopped or redeployed, no network probe was run, and production was not accessed or modified.**
