# ARCANOS Phase 2E Railway Preview — Draft Gates C and D

- Status: ready for explicit Gate C operator review; neither gate is approved or executed by this artifact
- Prepared: 2026-07-17
- Source branch: `codex/action-plan-execution-ownership`
- Approved local starting commit: `5e8ef46f48adea6eca82b4fd919821c939cca6c6`
- Final Phase 2E implementation tip: `d67f219bdb3c80f37698a40bcc0e1c09b99284cf`
- Proposed environment: `phase2e-validation-20260717`
- Proposed base environment: `phase2d-validation-20260717`
- Production authorization: none
- Commands executed while preparing this proposal: none

This proposal records the next bounded Railway decision. It does not authorize environment creation, variable or credential configuration, database migration, deployment, executor activation, traffic, teardown, or any production action.

## Gate readiness

| Gate | Current status | Required before an approval request |
|---|---|---|
| Gate C — fresh isolated environment | Ready for operator review | Commit the containing evidence artifact, prove a clean worktree, run the recorded read-only Railway CLI preflight, and obtain explicit authorization for preview-only environment/resource/variable creation |
| Gate D — migration and application deployment | Blocked | Gate C isolation evidence; reviewed preview-capable migration invocation; local ephemeral migration up/verify/compatibility/compensation evidence; exact final commit; clean preflight; preview-only credential-configuration authority; rollback target |
| Gate E — Python executor activation | Not included | Separate approval with one synthetic no-op action, principal/instance/agent identities, bounded claims/submissions, and exact expected writes |
| Gate F — push, PR, production, or teardown | Not included | Separate approval for each action |

## Gate C proposal — fresh isolated environment

### Target topology

| Item | Proposal | Isolation requirement |
|---|---|---|
| Railway project | `Arcanos` (`7faf44e5-519c-4e73-8d7a-da9f389e6187`) | Confirm the linked project before mutation |
| New environment | `phase2e-validation-20260717` | Fresh environment; never production |
| Base | `phase2d-validation-20260717` (`50a92b12-048a-4fec-8bff-282a72267920`) | Copy configuration shape only; do not inherit data stores or credentials by reference |
| Web | `ARCANOS V2` | Deploy only the exact final Phase 2E commit after Gate D |
| Worker | `ARCANOS Worker` | Deploy after web verification only; it is not an ActionPlan executor |
| Postgres | New preview-only instance | Distinct service, storage, private endpoint, user, password, and `DATABASE_URL`; no base or production reference |
| Redis | New preview-only instance | Distinct service, storage, private endpoint, credentials, and `REDIS_URL`; never authoritative for ActionPlan ownership or result acceptance |
| Python executor | None under Gates C/D | Activation requires Gate E |
| Public domain | New preview-only web origin | Must not replace or alias the Phase 2D preview or production domain |

### First-boot and provider isolation

Before any new application deployment can start, the preview must retain the Phase 2D.1 fail-closed controls:

- `ARCANOS_PREVIEW_ISOLATION` present and enabled;
- `PHASE2D_PREVIEW_ARMED` present and enabled;
- `FORCE_MOCK` present and enabled;
- effective provider base URL is a credential-free loopback mock target;
- no bridge, provider, generic daemon ActionPlan, or worker ActionPlan execution path is enabled;
- web uses `ARCANOS_PROCESS_KIND=web` and worker uses `ARCANOS_PROCESS_KIND=worker`;
- preview web and worker reference only the new preview Postgres and Redis;
- no production or Phase 2D preview data-store reference is present.

Provider request count must remain zero from environment creation through final smoke validation. A provider call, bridge call, production reference, or inherited non-preview data-store reference is an immediate stop condition.

### Credential configuration boundary

Phase 2E code and schemas are approved locally, but credential configuration is not. Gate C/D approval must explicitly authorize preview-only generation and secret-store placement for the documented requester, operator, executor, and MCP-principal bindings. Values must be generated outside Git, entered only through Railway's secret interface, never printed, and reported by name/presence only. Executor credentials may be configured for boundary validation but may not be used to claim or start work before Gate E.

### Planned read-only preflight commands

These commands are recorded from the previously verified Railway CLI 4.30.2 evidence. They have not been run for Phase 2E:

```powershell
railway --version
railway status --json
railway environment --help
railway service --help
railway variables --help
railway deployment --help
railway logs --help
```

Before Gate C mutation, the operator must review sanitized output proving the linked project and confirming the exact installed CLI syntax. Variable values and raw logs must not be retained.

### Mutation command hold

No environment-creation, database, Redis, domain, or variable-mutation command is written here as executable instructions because its exact installed Railway CLI syntax has not been captured in the repository evidence. Guessing that syntax would make this gate unsafe. After the read-only `--help` preflight, the release operator must add the exact commands and sanitized dry-run/target proof to this artifact and request Gate C approval before executing them.

Gate C must stop after proving:

1. the new environment has a new identifier;
2. Postgres and Redis are distinct from both `production` and `phase2d-validation-20260717`;
3. all application services are stopped or remain on the inherited preview-safe build;
4. provider and bridge controls are fail-closed;
5. variable names/presence are recorded without values; and
6. production deployment IDs, configuration, variables, data, and logs are unchanged.

## Gate D proposal — migration and exact-commit deployment

### Preconditions

Gate D cannot be requested until all of the following are attached:

- exact final Phase 2E commit and scoped commit list;
- clean worktree proof;
- passing final TypeScript/Python, OpenAPI, disclosure, concurrency, dependency, and guard evidence;
- local ephemeral migration apply, verification, rerun, old-app/new-schema compatibility, drain, and empty-schema compensation evidence;
- Gate C environment and data-store isolation proof;
- exact forward migration checksum `cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533`;
- exact preview-capable migration command reviewed to reject production and the Phase 2D environment;
- preview-only credential configuration authority;
- rollback application commit and drain criteria.

The current migration runner intentionally accepts only a loopback PostgreSQL URL whose database name matches `arcanos_phase2e_*`. Therefore it is not a preview migration command. Gate D remains blocked until a separately reviewed invocation can target only the new Phase 2E preview database while refusing all other environments. The ordinary application `DATABASE_URL`, startup bootstrap, web service, and worker service must never become migration authority.

### Planned deployment order after Gate D approval

1. Reconfirm the project, new environment, web, worker, Postgres, and Redis identifiers.
2. Reconfirm preview isolation and credential names/presence without printing values.
3. Prove no old web/worker replica is serving Phase 2E command traffic in the new environment.
4. Apply the checksummed additive migration once through the approved out-of-band preview migrator.
5. Verify ledger checksum, completed phases, indexes, constraints, row counts, query plans, foreign keys, and zero legacy-row rewrite.
6. Deploy the exact final Phase 2E commit to `ARCANOS V2` with `node scripts/start-railway-service.mjs` and `ARCANOS_PROCESS_KIND=web`.
7. Verify `/health`, `/healthz`, `/readyz`, schema-readiness failure modes, authentication failures, `Cache-Control: no-store`, fixed errors, and disclosure sentinels.
8. Deploy the same commit to `ARCANOS Worker` only if required for startup/runtime compatibility validation; it must not claim ActionPlan work.
9. Re-run health, first-boot log, provider-call, bridge-call, schema, disclosure, and production-non-impact scans.
10. Stop. Do not activate Python, claim work, submit a result, push, open a pull request, touch production, or tear down the environment.

### Planned deployment commands

The following command shapes are supported by existing repository guidance but remain placeholders until Gate C records the actual service/environment targeting proof:

```powershell
railway up --detach --service "ARCANOS V2" --environment "phase2e-validation-20260717"
railway logs --service "ARCANOS V2" --environment "phase2e-validation-20260717" --lines <BOUNDED_LINE_COUNT> --json
railway up --detach --service "ARCANOS Worker" --environment "phase2e-validation-20260717"
railway logs --service "ARCANOS Worker" --environment "phase2e-validation-20260717" --lines <BOUNDED_LINE_COUNT> --json
```

They are not approval-ready while `<BOUNDED_LINE_COUNT>`, the exact final commit, deployment source proof, and the preview migration command remain unresolved. No command in this section has been executed.

## Gate D smoke scope without executor activation

Gates C/D may validate only passive startup and boundary behavior:

- web and worker start against the new schema and isolated stores;
- missing/malformed/wrong-role credentials fail closed;
- command/result schemas reject cross-operation and oversized bodies;
- status/result reads are authenticated, no-store, bounded, and non-sensitive;
- command creation cannot proceed without an eligible configured executor/capability and must return a stable failure with zero runs;
- legacy result-shaped `/execute` input is rejected without dispatch;
- MCP exposes only the approved requester operations for an authenticated HTTP principal;
- provider, bridge, execution callback, worker ActionPlan job, local command, claim, start, result, success acknowledgement, and production write counts remain zero.

An end-to-end successful claim/start/result flow belongs to Gate E because it activates an executor.

## Stop and rollback rules

Immediate stop conditions include schema checksum mismatch, migration partial state, invalid index, old/new application overlap, non-preview database reference, provider or bridge call, credential or payload disclosure, unexpected run creation, worker claim, production change, or any health/readiness regression.

Before Gate E there should be zero nonterminal runs. Application rollback keeps the additive schema in place and restores only a Phase 2E compatibility build that preserves command/result separation and authentication. A compensating schema drop is not part of Gate D; it requires separate evidence-retention approval and an empty isolated preview. Environment deletion is Gate F only.

## Evidence required after approved execution

- new environment, service, deployment, Postgres, and Redis identifiers;
- exact source commit and image/deployment provenance;
- variable names/presence only;
- migration ledger version/checksum/phase and schema verification;
- sanitized first-boot and bounded log scans;
- health/readiness and passive boundary smoke results;
- provider, bridge, claim, start, result, and production-impact counters;
- rollback/drain status; and
- explicit confirmation that no Python executor was activated and no production action occurred.
