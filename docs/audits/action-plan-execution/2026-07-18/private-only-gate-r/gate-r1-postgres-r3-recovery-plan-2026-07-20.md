# Gate R1 PostgreSQL R3A identity-creation plan

Status: **LOCAL R3A IDENTITY-ONLY PROCEDURE — NOT RAILWAY AUTHORIZATION**

This additive procedure supersedes only the next PostgreSQL recovery step after
the consumed R2 attempt. It does not rewrite the historical R2 runbook or
evidence. Railway mutation requires the separate exact authorization in
`gate-r1-postgres-r3-authorization-request-2026-07-20.md` against the final
reviewed local commit.

## Fixed scope

- Project: `Arcanos` (`7faf44e5-519c-4e73-8d7a-da9f389e6187`)
- Environment: `phase2e-validation-20260717`
  (`fb99f47d-5ef5-44c1-96c2-acf7b90fab13`)
- Private network: `464f2194-3825-4ac1-a705-192566561675`
- New one-attempt service name: `phase2e-postgres-r3-20260720`
- Authorized data-service/infrastructure mutation count: exactly `1`
- Separately bounded access-control operations: at most one temporary token
  creation and exactly one revocation if creation occurred

If the R3 name already exists, stop. Do not reuse, repair, delete, or silently
advance to another name.

## Retained resources

These resources must remain offline, attached, and unchanged:

| Role | Service ID | Volume ID |
| --- | --- | --- |
| Original PostgreSQL | `b7789306-8aef-4113-add5-02883a6cc087` | `35c26093-1e3f-4d34-b699-89c65d2fb92d` |
| Original Redis | `434fa5b4-b52c-4caf-aaba-e87c173bf10d` | `d3690500-fcc5-4c06-afa6-cf30e91f608d` |
| Failed PostgreSQL R2 | `a2a57da4-a928-427f-be30-d4a68b59a117` | `2998734d-7530-4f26-b715-cea4780bd437` |
| Retained Redis R2 | `1ac0bd56-50b3-49eb-954c-ea83515ec915` | `983c4f0a-9180-4621-b65e-dfdd0b79f2bd` |

Redis R2 remains source-less and offline. R3A does not activate, configure,
restart, replace, or otherwise mutate Redis.

## Temporary token contract

One temporary environment-scoped Railway project token may be created for this
gate. It may be injected only into the reviewed one-prompt projector process,
used only for the fixed R2 preflight and environment-metadata projections, then
revoked immediately and removed from the process environment. Its value must
never enter chat, command arguments, shell history, a repository file, an
evidence artifact, or projector output. Stop if the token cannot be scoped,
confined, or revoked exactly as required. Token creation and revocation are
access-control operations recorded separately from the single data-service
mutation; they authorize no other Railway control-plane change.

## Required live preflight

Immediately before the sole mutation:

1. Use an isolated temporary Railway link and prove the exact project and
   environment.
2. Use only the schema-locked projectors. The dedicated
   `ARCANOS_GATE_R1_RAILWAY_PROJECT_TOKEN` may exist only in the projector child
   process; do not fall back to personal or CLI credential stores.
3. Prove all four retained data services have zero active deployments, zero
   Railway domains, zero custom domains, and zero TCP proxies.
4. Prove `ARCANOS V2`, `ARCANOS Worker`, both validators, Python daemons,
   bridges, and executors are inactive in the target environment.
5. Prove the fixed private network is the sole active private network and prove
   the R3 name is absent project-wide.
6. Capture stable production and Phase 2D identities read-only for the later
   non-impact comparison.

No historical count satisfies this preflight. Missing, stale, ambiguous, or
nonzero evidence stops the gate.

## Sole authorized mutation

After all preconditions pass, execute exactly one target-confirmed empty-service
creation equivalent to:

```text
railway add --service phase2e-postgres-r3-20260720 --json
```

Do not attach a source, image, volume, variables, configuration, domain, proxy,
or deployment as part of creation.

## Read-only post-create proof and stop boundary

After creation, use only a fresh environment-metadata projection to require:

- exactly one project service and one environment service instance with the R3
  name;
- a new service ID and service-instance ID distinct from every retained,
  validator, web, and worker identity;
- `sourceKind: NONE`, no repository, no latest or active deployment;
- no service-local variables;
- zero Railway-provided and custom domains; and
- no volume associated with the new service.

Record only the safe new identities and projected categories. Stop immediately
after the unique empty identity is observed; do not continue in the same
session. If creation or proof is ambiguous or fails, retain the empty service
unchanged and request separate containment, cleanup, or retry authority.

R3A does not claim a current TCP-proxy count for the new dynamic identity. A
fresh exact-ID TCP-proxy count of zero is a mandatory R3B precondition before
any volume, credential, configuration, source, image, endpoint, or deployment
mutation.

## Not authorized in R3A

R3A does not authorize volume creation or attachment, credential generation,
variable reads or writes, configuration or environment patches, source or image
assignment, deploy/redeploy/restart/down operations, readiness or `psql`, TCP
proxy or domain mutation, containment, repair, retry, deletion, Redis mutation,
migrations, applications, workers, validators, daemons, executors, ActionPlans,
provider calls, production or Phase 2D mutation, push, PR, or merge.

## Future R3B prerequisites — not authorized and not executable here

Before a separate R3B request can be prepared:

- pin the newly observed R3 service and service-instance IDs into the secure
  projector session and the TCP-proxy projector;
- independently review a fixed PostgreSQL-only configuration patch wrapper;
- retain the fixed private-network pin and service-specific PostgreSQL image
  approval;
- add tests proving the R3-bound tooling cannot target Redis, retained services,
  validators, web, worker, production, or Phase 2D; and
- obtain fresh zero-proxy proof for the exact R3 identity.

R3B requires a new local commit, independent review, and separate explicit
operator approval.

## Evidence contract

The R3A artifact may contain only sanitized IDs, counts, source/deployment
categories, source commit, data-service mutation count, separately counted token
create/revoke operations, non-impact results, limitations, and an independent
verdict. It must contain no token, credential, connection string,
resolved reference, endpoint, raw log, raw variable output, or secret
fingerprint.
