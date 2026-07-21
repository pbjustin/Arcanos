# ARCANOS Phase 2E — Gate R1 Combined Isolation Proof Authorization Request

Authorize one read-only combined Gate R1 isolation proof for the exact Phase 2E
preview environment. No Railway mutation is authorized by this request.

Require these committed prerequisite results:

- PostgreSQL R3 readiness evidence commit
  `4c8d5c7650ace6a511f04b99680b560cee73c117`.
- Redis R2 readiness evidence commit
  `09812d9e6f614eb7206f8a59c683eb947f5149a1`.
- Clean branch `codex/phase2e-advisory-history-gate-r` containing both commits.
- Railway CLI `4.30.2`, executable SHA-256
  `87C3047C7F4A7E8162ED4783592460A226DA322074005BAF1351532A360E5D73`,
  and isolated link to project `Arcanos`, environment
  `phase2e-validation-20260717`, service `None`.

Exact target:

```text
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13
Private network ID: 464f2194-3825-4ac1-a705-192566561675
PostgreSQL R3 service: 7346b3f6-bf3d-46e1-9d66-79f10847ef89
PostgreSQL R3 instance: 86dde430-50ac-4d5c-95c3-cb27064eff51
PostgreSQL R3 deployment: b5e45d34-19b8-4253-b230-c3ab0b60b0d7
Redis R2 service: 1ac0bd56-50b3-49eb-954c-ea83515ec915
Redis R2 instance: 0f34bcbb-bfd0-4df5-954a-bb97371bd460
Redis R2 deployment: 9f102e53-ef25-46b5-80e8-0243eb1512d6
```

Create at most one temporary environment-scoped project token out of band.
Enter it only in the reviewed masked projector-session prompt. Never print,
persist, hash, fingerprint, or place it in an argument. Revoke it immediately
after the session is stopped and acknowledged.

Use this exact session ledger:

```text
1  environment metadata
2  original PostgreSQL fixed-proxy count
3  original Redis fixed-proxy count
4  failed PostgreSQL R2 replacement-proxy count
5  active PostgreSQL R3 replacement-proxy count
6  active Redis R2 replacement-proxy count
7  PostgreSQL R3 private endpoint
8  Redis R2 private endpoint
9  stop and acknowledge consumed-through sequence 9
```

After requests 1–8 and before request 9, run each existing exact deployment
verification once:

```text
node scripts/gate-r1-postgres-r3-deployment-status.js --operation verify-success --service-id 7346b3f6-bf3d-46e1-9d66-79f10847ef89 --deployment-id b5e45d34-19b8-4253-b230-c3ab0b60b0d7
node scripts/gate-r1-redis-r2-deployment-status.js --operation verify-success --service-id 1ac0bd56-50b3-49eb-954c-ea83515ec915 --deployment-id 9f102e53-ef25-46b5-80e8-0243eb1512d6
```

Acceptance requires:

- exact project, environment, and private-network identities;
- original PostgreSQL, original Redis, and failed PostgreSQL R2 have no active
  deployment, zero domains, and their exact retained volumes;
- PostgreSQL R3 and Redis R2 each have exactly their one known `SUCCESS`,
  unstopped deployment, exact image, exact fresh volume, exact approved
  variable-name set, no public-URL variable, and zero domains;
- all five proxy counts are zero;
- both replacement endpoints are present and `ACTIVE` on the exact private
  network;
- both exact deployment verification wrappers return `PASS`;
- PostgreSQL and Redis authenticated readiness remain established by their
  committed evidence and are not rerun;
- application and worker service instances are absent, validators have no
  deployment, and shared variables are empty; and
- no migration, SQL, Redis data operation, application, worker, daemon,
  executor, ActionPlan, provider, domain, proxy, service, volume, variable, or
  configuration mutation occurs.

Production and Phase 2D are not selected. Non-impact relies on the preserved
stable-identity baseline plus the absence of any mutation command targeting
those environments; do not claim a fresh cross-environment comparison.

Stop on any mismatch or projector failure. Do not retry, repair, activate,
restart, redeploy, delete, migrate, or continue to Gate R2. Return a sanitized
combined evidence artifact, independent review, secure-session cleanup, and
token-revocation confirmation.
