# Gate R1 PostgreSQL R3A identity-creation authorization request

Status: **COPY-READY REQUEST — NOT AUTHORIZATION BY THIS DOCUMENT**

Replace `<FINAL_LOCAL_R3A_PREFLIGHT_COMMIT>` only after focused tests, secret
scan, diff review, independent review, and a scoped local commit pass.

```text
Authorize ARCANOS Phase 2E Gate R1 PostgreSQL R3A identity creation only.

Target:
Project: Arcanos
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment: phase2e-validation-20260717
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13
Reviewed source commit: <FINAL_LOCAL_R3A_PREFLIGHT_COMMIT>

Resources that must remain offline, retained, and unchanged:
- Original PostgreSQL service b7789306-8aef-4113-add5-02883a6cc087; volume 35c26093-1e3f-4d34-b699-89c65d2fb92d
- Original Redis service 434fa5b4-b52c-4caf-aaba-e87c173bf10d; volume d3690500-fcc5-4c06-afa6-cf30e91f608d
- Failed PostgreSQL R2 service a2a57da4-a928-427f-be30-d4a68b59a117; volume 2998734d-7530-4f26-b715-cea4780bd437
- Retained Redis R2 service 1ac0bd56-50b3-49eb-954c-ea83515ec915; volume 983c4f0a-9180-4621-b65e-dfdd0b79f2bd

Mandatory preconditions immediately before the sole mutation:
- Use an isolated temporary Railway link and reverify the exact project and environment.
- Create at most one temporary environment-scoped project token; inject it only into the reviewed projector process, use it only for the fixed projections, revoke it immediately after proof, and remove it from the process environment.
- Require fresh schema-locked metadata and TCP-proxy projections.
- Prove all four retained data services have no active deployment and zero Railway domains, custom domains, and TCP proxies.
- Prove ARCANOS V2, ARCANOS Worker, both validators, Python, bridges, daemons, and executors are inactive.
- Prove private network 464f2194-3825-4ac1-a705-192566561675 is the sole active private network and phase2e-postgres-r3-20260720 is absent project-wide.
- Stop if any proof is unavailable, ambiguous, stale, or nonzero.

Authorized work:
- Perform exactly one data-service/infrastructure mutation: create one empty service named phase2e-postgres-r3-20260720 in the exact target environment.
- Use only read-only environment-metadata projection after creation to resolve its unique service and service-instance IDs and prove it has no source, repository, deployment, variables, domains, or volume.
- Record only sanitized identities, counts, categories, the single data-service mutation count, separately counted token creation/revocation operations, and non-impact evidence.
- Stop immediately after the unique empty identity is observed; do not continue in the same session.

Not authorized:
- Volume creation, attachment, detachment, resize, or deletion.
- Credential generation, rotation, retrieval, comparison, or configuration.
- Variable reads or writes, configuration or environment patches.
- Source or image assignment, deploy, redeploy, restart, down, scale, containment, or readiness/psql operations.
- TCP-proxy or domain creation, removal, or other networking mutation.
- Repairing, retrying, deleting, or reusing a partial R3 service.
- Any change to the four retained services or volumes listed above.
- Redis activation, deployment, credentials, configuration, restart, replacement, or deletion.
- Creating any additional PostgreSQL or Redis service.
- Deploying applications, workers, validators, daemons, bridges, or executors.
- Migrations, DDL, application SQL, Redis operations, ActionPlans, execution runs/results, provider calls, production or Phase 2D mutation.
- Gate R1 R3B, Gate R2, Gate V, Gate M, Gate D, push, PR, merge, or any production action.

Immediate stop conditions:
- Any target, identity, token scope, private-network, exposure, source, deployment, or non-impact assertion fails.
- Any retained service becomes active.
- The R3 name already exists.
- Any secret, connection string, resolved variable, or fingerprint appears in output or evidence.
- Any unauthorized operation occurs.

On failure, stop and retain any empty R3 service unchanged. Do not contain, repair, retry, delete, attach a volume, configure, deploy, activate Redis, or advance to R3B without separate explicit approval.

R3A does not establish the new service's TCP-proxy count. Before any R3B mutation, bind the observed exact R3 IDs into reviewed schema-locked tooling and obtain a fresh exact-ID TCP-proxy count of zero.

This authorization permits one empty-service identity mutation plus the separately bounded temporary-token create/revoke lifecycle only. It authorizes no other Railway control-plane change. Return with sanitized R3A evidence and a separate local-tooling proposal for R3B.
```
