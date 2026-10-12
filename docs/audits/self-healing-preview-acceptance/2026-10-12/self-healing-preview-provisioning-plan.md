# Managed self-healing preview preparation

Historical plan: the owner subsequently deferred live verification in favor of
synthetic acceptance. The PR-only preflight workflow and profile were retired;
the instructions below document the earlier attempt and are not an active
provisioning handoff. See the [acceptance index](README.md) for the current merge
policy and evidence.

PR: [#1539](https://github.com/pbjustin/Arcanos/pull/1539).
Branch: `codex/targeted-security-healing-20261012`.

This follow-up records the owner's authorization to establish the isolated
preview profile recommended in the merge-readiness assessment. Authorization
does not establish credential availability, isolation, a deployment or live
acceptance. Production restrictions and the prohibition on merging PR #1539
remain in force.

## Current execution boundary

The native sealed lifecycle remains unchanged. It checks out trusted
`github.workflow_sha` and its protected GitHub environment admits `main` only.
Its hardcoded production-shared service IDs and passive runtime cannot satisfy
this mission. Adding an opt-in label or dispatching it would not select the new
profile.

The current Railway connector can inspect resources and create services, but
does not expose environment creation in the required existing project. A
checksum-verified Railway CLI `5.23.3` returned `Unauthorized. Please login with
railway login` for `whoami --json`. No resource mutation followed. The current
managed executor reports no configured secret bindings. GitHub administration
and secret-list HTTP 403 responses are unavailable evidence, not proof that a
protected repository secret is absent.

The owner selected an owner-run trusted workflow rather than supplying a token
to this session. A read-only preflight handoff is being prepared on the PR
branch using the existing protected lifecycle credential. Tokens must never be
pasted into chat or committed, and the credential remains outside candidate
application processes. This choice does not install a workflow on `main`.

Read-only production service configuration metadata confirms that both app
roles source `pbjustin/Arcanos` branch `main`. Neither response provides a
watch-path exclusion or disabled-trigger attestation for the proposed
installation. This is not evidence that
a production deployment occurred; it means a production-free installation has
not been proven. Main promotion/installation remains an owner prerequisite and
must not be performed through this mission while it could trigger production.

## Exact proposed resource scope

| Field | Required value |
| --- | --- |
| Repository | `pbjustin/Arcanos` |
| PR admission | Open, non-draft, same repository, base `main`, exact freshly inspected head |
| Workspace | `1c9265a3-986f-4304-ad3e-5a874caab039` |
| Project | `7faf44e5-519c-4e73-8d7a-da9f389e6187` |
| Dedicated normal-runtime name | `self-healing-pr-1539-e2e` |
| Environment creation | Empty environment, no source environment or inherited configuration |
| Services | Four fresh globally unique IDs: web, worker, PostgreSQL, Redis |
| Storage | Fresh private PostgreSQL and Redis; fresh owned volumes; no public storage domains or TCP proxies |
| Application source | Exact reviewed PR branch and commit; no uncontrolled source trigger |
| Replicas | One per application role, with bounded resource limits |
| Credentials | Newly generated purpose credentials and private preview storage references only |
| Provider | Contained loopback fixture and fictional SDK key; no real provider credential |
| Cleanup | Only receipt-owned resources, with current identity revalidation and absence proof |

This is a separate declared normal-runtime profile. The existing
`pr-676861-1539` sealed namespace and its authorization/isolation rules retain
their current meaning. An unrelated successful deployment is not a target.

## Preparation and attestation contract

The additive profile module prepares a credential-free plan and validates
ownership/topology observations. Planning requires complete fresh inventory.
New environment, service and volume IDs must be distinct and absent from that
inventory; canonical production identities are independently denied. A bounded
timestamped receipt binds the plan and exact source and survives serialization
across an operator restart. Its digest detects accidental binding drift; it is
not cryptographic proof of platform ownership or permission to delete.

Attestation requires complete fresh observations, exact roles and source SHAs,
successful sole active application deployments, private storage, expected
volume ownership, and explicit credential/configuration isolation evidence.
Missing or partial observations reject acceptance. It returns no credentials.
Mocked observations in contract tests cannot prove Railway isolation.

For the admitted official PostgreSQL 18 image, the persistence mount is
`/var/lib/postgresql`. The admitted Redis image requires an explicit AUTH
startup command using the preview-created password; declaring `REDIS_PASSWORD`
alone does not configure server authentication. Config validation remains
separate from actual authentication and durability probes: both are explicitly
unverified in the local contract result.

The module is a planning and attestation prerequisite. It does not create an
environment, deploy services, authenticate an operator, implement the runtime
supervisor, inject a failure or run the fourteen live scenarios. No new workflow
has been installed or executed. Those actions remain blocked until the
execution authority and reviewed runtime implementation exist.

## Required runtime implementation

The next implementation must run the unchanged integrity gate and normal web
and job-runner entrypoints with a literal child-environment allowlist. It must
deny management tokens, real model credentials, alternate data URLs, ambient
preloads/proxies and external integration credentials before runtime import.
A bounded provider fixture may listen only on loopback. Any test command
surface must be preview-only, authenticated, bounded and absent in production.

The normal web process can own an explicitly authorized manual canonical
controller tick and the Trinity request that consumes its mitigation. Automatic
web suppression stays enabled. Worker retries and leases use the actual durable
job runner and private storage. This proves the declared same-process path;
it does not establish automatic worker-to-web mitigation delivery.

Real TTL acceptance must wait the existing ten-minute Trinity TTL. Do not fake
the clock, inject diagnostic snapshots, mock actuators, or relabel a fixture as
real provider availability. Each scenario needs controller and actual consumer
evidence plus clearing or rollback and return to baseline.

## Activation routes requiring resolution

The selected owner route is the additive
[Railway Self-Healing Preview Preflight](https://github.com/pbjustin/Arcanos/blob/1aca3cbf82c95a89cd9c7b5bad8c6478e1fa2988/.github/workflows/railway-self-healing-preview-preflight.yml).
Its reviewed main-only controller uses the existing protected lifecycle
credential for metadata reads, never checks out candidate code, and rejects
owner/provenance/head/base/branch drift. Its artifact is uploaded only after an
exclusive sanitized report write succeeds. Planning success retains
`status: BLOCKED`, no deployment and no live acceptance; it is not a
provisioning executor.

After the owner proves installation cannot trigger production, installs the
reviewed preflight/controller/profile files through the trusted route, and
refreshes the actual PR head, the owner can dispatch:

```bash
gh workflow run railway-self-healing-preview-preflight.yml \
  --repo pbjustin/Arcanos --ref main \
  --field pr_number=1539 --field expected_sha=<fresh-exact-PR-head-SHA>
```

The SHA placeholder must be replaced before invoking. The workflow must first
exist on `main`; a branch-only definition is not dispatchable. Retain its
`self-healing-preview-preflight-<run>-<attempt>` artifact and record the
controller/candidate identities. A blocked or plan-only result cannot authorize
resource creation. The bounded mutation executor, actual observation collector
and preview-only runtime supervisor still require reviewed implementation and
successful live verification.

1. A reviewed infrastructure-only installation on trusted `main`, performed
   through owner review and checks. It is distinct from merging PR #1539 and
   must first prove that installation cannot trigger a production deployment.
   It also requires an explicit resolution of the existing branch-only change
   restriction and available protected workflow authority.
2. An explicitly reviewed pre-merge operator bootstrap, following the existing
   [operator provenance pattern](../../../LIVE_VALIDATION.md#initial-pre-merge-cli-operation).
   A new self-healing executor must bind its clean reviewed controller SHA,
   real successful offline gate evidence, exact candidate source and durable
   ownership/cleanup receipts. The existing Gaming-only controller is not a
   self-healing executor and must not be used as a fallback.

Neither route is activated by this document or by a mocked contract pass.
No environment, service, volume, deployment, credential or production
configuration has been created or changed in this follow-up.
