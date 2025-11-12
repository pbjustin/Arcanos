# Railway GraphQL Integration Guide

## Overview
The ARCANOS control plane uses Railway's public GraphQL API to inspect deployment state and automate release operations. All interactions flow through the `src/services/railwayClient.ts` module, which wraps the Backboard GraphQL endpoint with structured logging, timeout guards, and typed helpers.

## Endpoint and Authentication
- **Endpoint:** `https://backboard.railway.app/graphql` by default. Override with `RAILWAY_GRAPHQL_ENDPOINT` when testing against a mock service or a future Railway edge domain.
- **Authentication:** Every request is authenticated with the bearer token stored in `RAILWAY_API_TOKEN`. The environment validator enforces a minimum token length and provides setup guidance so production builds fail fast when the token is missing or malformed.
- **Timeouts:** Requests default to 15 seconds. You can raise or lower the threshold with `RAILWAY_GRAPHQL_TIMEOUT_MS`. Invalid values log a warning and fall back to the default to keep the client resilient to misconfiguration.

## Client Responsibilities
`railwayClient.ts` centralizes the following concerns:

1. **Token detection.** Requests are short-circuited with a descriptive error if no API token is present, which prevents accidental unauthenticated calls.
2. **Abortable fetches.** Each call uses `AbortController` so long-running GraphQL requests can be cancelled when the timeout elapses. The aborted state surfaces as a typed `RailwayApiError`.
3. **Error reduction.** GraphQL errors, non-200 HTTP responses, and malformed JSON payloads are translated into uniform `RailwayApiError` messages. The helper automatically truncates large response bodies to keep logs readable while still surfacing enough context to debug failures.
4. **Structured logging.** Successful probes and failures are recorded via `structuredLogging`, ensuring observability across deployments.

## Supported Operations
The client exposes a focused set of helpers that match our operational workflows:

| Helper | GraphQL Operation | Description |
| --- | --- | --- |
| `listProjects()` | `ViewerProjects` query | Returns the project hierarchy (projects → environments → services) along with the latest deployment metadata for each service. Used by health checks and dashboards to confirm Railway connectivity. |
| `deployService({ serviceId, branch?, commitId? })` | `DeployService` mutation | Starts a new deployment for a service, optionally pinning a branch or commit. Surfaces the resulting deployment identifier and status for downstream polling. |
| `redeployEnvironment({ environmentId })` | `RedeployEnvironment` mutation | Triggers a redeploy of the latest artifact across every service in an environment. Useful when replaying configuration changes or secrets updates. |
| `promoteDeployment({ deploymentId })` | `PromoteDeployment` mutation | Promotes an existing deployment into its target environment (e.g., staging → production). Returns the promotion target to confirm routing. |
| `probeRailwayApi()` | Composite query | Performs a lightweight availability check by calling `listProjects()` and summarizing the counts of projects, environments, and services. Designed for readiness endpoints and CI smoke tests. |

Each helper returns typed objects so call sites can destructure IDs and statuses without manual casting.

## Example Usage
```ts
import railwayClient from '../src/services/railwayClient.js';

async function rolloutLatestBuild(serviceId: string) {
  const { deploymentId, status } = await railwayClient.deployService({ serviceId, branch: 'main' });

  if (status !== 'PENDING') {
    throw new Error(`Unexpected status from Railway: ${status}`);
  }

  return deploymentId;
}
```

For manual queries, you can interact with the API using `curl` or GraphQL clients. Ensure the `Authorization` header includes the Railway token:

```bash
curl https://backboard.railway.app/graphql \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $RAILWAY_API_TOKEN" \
  -d '{
    "query": "query { viewer { id } }"
  }'
```

## Operational Tips
- **Token scope:** Generate tokens from the Railway account dashboard with "Full Access" to unlock deployment mutations. Read-only tokens will succeed for queries but fail for write operations.
- **Rate limits:** Railway applies per-account limits. Keep background polling (such as `probeRailwayApi`) infrequent—once per minute is typically sufficient.
- **Secret management:** Store the token in Railway's environment variable manager so redeploys inherit the credential automatically across services and environments.
- **Auditing:** GraphQL mutations appear in Railway's deployment history and CLI logs. Use these audit trails to trace who triggered redeploys or promotions.

## Related Files
- Client implementation: `src/services/railwayClient.ts`
- Environment validation rules: `src/utils/environmentValidation.ts`
- Configuration checklist: `DEPLOYMENT_GUIDE.md`
