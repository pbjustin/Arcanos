# Gate R1 PostgreSQL R3B1 authorization request

Status: **COPY-READY REQUEST — NOT AUTHORIZATION BY THIS DOCUMENT**

Reviewed tooling commit:
`21736924568fd38742ef8b2064c157fed00277b4`.

```text
Authorize ARCANOS Phase 2E Gate R1 PostgreSQL R3B1 offline preparation only.

Target:
Project: Arcanos
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment: phase2e-validation-20260717
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13
Private network ID: 464f2194-3825-4ac1-a705-192566561675
PostgreSQL R3 service: phase2e-postgres-r3-20260720
Service ID: 7346b3f6-bf3d-46e1-9d66-79f10847ef89
Service-instance ID: 86dde430-50ac-4d5c-95c3-cb27064eff51
Reviewed source commit: 21736924568fd38742ef8b2064c157fed00277b4

Mandatory live preconditions:
- Require Railway CLI 4.30.2 and reviewed railway.exe SHA-256 87C3047C7F4A7E8162ED4783592460A226DA322074005BAF1351532A360E5D73 immediately before execution.
- Use an isolated temporary Railway link and require the exact project, environment, and Service: None.
- Use at most one temporary environment-scoped project token only in the reviewed secure projector session; revoke it immediately after the final read-only proof.
- Require `MaximumRequests=20` and follow the committed 15-request ledger exactly; unused capacity authorizes nothing.
- Prove the exact R3 identity is unique, undeleted, source-less, undeployed, variable-free, volume-free, and has zero Railway/custom domains.
- Prove a fresh exact-ID TCP-proxy count of zero for the R3 service and instance.
- Prove the exact private network is the sole active private network.
- Prove the four retained data services remain offline, unchanged, and unexposed with their existing volumes.
- Prove validators, web, worker, Python, bridge, daemon, and executor runtimes are inactive in the target environment.
- Capture sanitized production and Phase 2D stable identities for post-operation non-impact comparison.
- Stop if any evidence is missing, ambiguous, stale, nonzero, or inconsistent.

Authorized R3B1 mutations, in this order and only against the exact R3 service:
1. Create and attach one fresh environment-local volume at /var/lib/postgresql/data.
2. Generate one independent 32-byte CSPRNG POSTGRES_PASSWORD entirely in memory and set it through stdin with deployment suppressed.
3. Set exactly eleven reviewed non-secret or Railway-reference PostgreSQL variables in one fixed ordered batch command with deployment suppressed, yielding exactly twelve allowed service-local variable names including POSTGRES_PASSWORD and no public-URL name.
4. Apply the committed PostgreSQL-only service-configuration profile, setting only restartPolicyType=ON_FAILURE and restartPolicyMaxRetries=3.
5. After each mutation, run fresh schema-locked metadata and exact-ID exposure checks.

Execution controls:
- Use only the committed `volume`, `credential`, `variables`, and `service-configuration` operations; exactly four mutation commands are authorized.
- Invoke them only through `scripts/gate-r1-postgres-r3-offline-mutation.js` and `scripts/gate-r1-postgres-r3-config-patch.js`; the historical R2 runbook is not executable authority.
- Reject every ambient Railway token variable before a mutation child process starts; the temporary project token is projector-only.
- Forward only the committed OS path/temp/home/credential-store child-environment allowlist; do not forward provider, database, Redis, application, or unrelated secrets.
- Bound every child process to 30 seconds and expose only fixed non-sensitive failure codes.
- The `postgres-source` profile must be unavailable and rejected before any child process starts.
- Treat any failed, partial, ambiguous, or apparently split variable batch as stop-without-retry; run only the safe post-attempt projection pair when possible.
- Invoke the volume operation at most once. A timeout, lost response, or interruption consumes this authorization and requires fresh projection plus separate recovery approval.
- Use requests 13–14 as the final stop-state proof, then request 15 to stop and acknowledge the secure session before revoking the temporary token.
- Do not query an endpoint in R3B1.

Required stop state:
- sourceKind remains NONE;
- no repository or image is configured;
- no deployment exists or starts;
- exactly one fresh volume is attached at /var/lib/postgresql/data;
- the service-local variable-name set is exact and contains no public URL;
- restart policy is ON_FAILURE with maximum retries 3;
- Railway domain, custom-domain, and TCP-proxy counts remain zero;
- retained resources and production/Phase 2D identities remain unchanged.

Not authorized:
- Image or source assignment, deployment, redeploy, restart, down, readiness, psql, SQL, migration, or application connection.
- Redis mutation or activation.
- Domain or TCP-proxy creation/removal.
- Any mutation to retained services or volumes.
- Applications, workers, validators, daemons, executors, ActionPlans, providers, production, or Phase 2D.
- Gate R3B2, R2, V, M, D, push, PR, merge, or production work.
- Retry after an ambiguous mutation response.
- Eleven individual variable-setting commands or any CLI behavior that splits the fixed batch into operator-visible mutation steps.

On any failure, stop and retain the partial R3 service and its volume offline. Do not repair, retry, delete, activate a source, or advance without separate authorization.
```
