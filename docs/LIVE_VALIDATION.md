# Live PR validation on Railway

> Companion operations runbook. Last reviewed: 2026-10-06.
> Local implementation and checks do not establish deployment or paid acceptance.

The initial supervisor/mTLS design proved substantially more complex than
necessary for pre-merge live validation. The final implementation uses a single
isolated ARCANOS validation service, Railway environment isolation, existing
ARCANOS source-acquisition controls, transient Gaming behavior, exact-SHA
deployment proof, and bounded paid model execution. The complete original-diff
classification is in [the PR 1528 audit](LIVE_VALIDATION_PR1528_AUDIT.md).

```text
Existing ARCANOS Railway project
└── live-validation
    └── ARCANOS V2 Validation
        ├── exact requested PR SHA and compiled-artifact proof
        ├── validation-only OpenAI key and authenticated test execution
        ├── real public HTTPS guide acquisition
        ├── real Trinity generation and mandatory CLEAR answer audit
        ├── transient-only Gaming, no player persistence
        ├── no production Postgres, Redis, credentials or traffic
        └── bounded paid calls and sanitized stage evidence
```

The project is `7faf44e5-519c-4e73-8d7a-da9f389e6187`. The target permits only
`live-validation` and the dedicated validation service. Production environment
`fb583147-6c39-4343-9267-500f357d25ab` and known production resource IDs are denied.
A production clone or inherited production shared variables fails isolation.
Creating a service or editing repository wiring must be scoped to this validation
environment; project-wide changes are outside this facility's authority.

## Provisioning and one-time secret binding

Create an empty `live-validation` environment in the existing project, then one
service named **ARCANOS V2 Validation**. Review the actual environment inventory:
no production service, Postgres, Redis, data volume, shared credentials, background
worker or application traffic may be attached. Bind a normal Railway HTTPS domain
for the authenticated validation endpoints, using a generated `*.up.railway.app`
origin. A domain is a transport route; it
does not grant test access or establish source/deployment identity.

Apply and read back the environment-scoped profile in
[runtime.railway.json](../infra/live-validation/runtime.railway.json): the
[runtime Dockerfile](../infra/live-validation/runtime.Dockerfile), dedicated
`start-live-validation-runtime.mjs` launcher, one replica, `NEVER` restart policy
and readiness health check. Disable automatic source deployments. Repository
connection alone does not prove an exact deployed revision. A JSON file in Git
alone does not prove that a new Railway service applied those settings.

Fill [target.example.json](../infra/live-validation/target.example.json) with the
real validation environment/service IDs, public HTTPS origin, existing Gaming
model identities and reviewed conservative per-model input/output price ceilings.
These nonsecret model/pricing values require verification; they are not inferred
from a redacted production credential or a successful request. Missing IDs or pricing
fail closed. The fine-tuned authority remains the application's real authority;
helper models preserve their existing roles. A convenient base model cannot be
substituted to manufacture acceptance.

Bind these service-specific variables outside Git:

| Variable | Purpose |
| --- | --- |
| `ARCANOS_LIVE_VALIDATION_TARGET_JSON` | Validated target, identity, model and limit configuration. |
| `ARCANOS_LIVE_PREVIEW_OPENAI_API_KEY` | Dedicated validation OpenAI credential; one-time secure UI/CLI binding. |
| `ARCANOS_LIVE_VALIDATION_TEST_TOKEN` | Deployment-bound validation bearer generated/bound by the controller outside Git. |
| `NODE_ENV`, `TZ`, `PORT` | Normal launcher settings; production mode, UTC and Railway listener port. |

Railway supplies project, environment, service, deployment and commit metadata;
startup compares these with the target and image manifest. Use only the launcher's
closed variable allowlist. Do not attach `DATABASE_URL`, Redis, production OpenAI,
Notion, OAuth, worker, memory or player-progress credentials. The controller creates the test bearer automatically for the exact deployment;
no additional manual bearer binding is required. The bearer provides test
execution permission only. It is not accepted by production OAuth
or a Gaming storage route.

Connected OAuth may show the name of a production OpenAI variable while
withholding its value. That is normal secret redaction, not an application
failure or a reason to copy production values. If connected tooling cannot bind
the dedicated credential securely, the remaining credential action is exactly:

**Bind the validation OpenAI key to the live-validation service.**

The binding remains on the reusable service across exact-SHA deployments, so
future PR tests do not require rebinding. Never paste a secret into workflow
inputs, chat, a command argument, Git, logs or artifacts. This facility does not
recreate or copy production secrets, modify OAuth, or change installed plugins.

## Exact-SHA deployment and admission

The [manual workflow](../.github/workflows/live-pr-acceptance.yml) and
[controller](../scripts/live-validation-controller.mjs) resolve the PR's current
head or accept an exact requested SHA. A PR run must remain bound to its reviewed
head; moved or ambiguous heads fail before paid acceptance. Branch names never
serve as deployment identity. The workflow performs these steps:

1. Resolve and verify the requested PR head, then check out exactly that SHA.
2. Run credential-free source, containment, build and static validation gates.
3. Build the validation image at the exact SHA and bind source/tree identity to
   the compiled-content manifest under `/opt/validation/build.json`.
4. Verify the image's source SHA and compiled digest. Final image layers contain
   no Git history; source fetches use depth one and no tags.
5. Check the isolated Railway target and deploy only the dedicated validation
   service with the exact commit SHA.
6. Read back actual deployment ownership/status and source commit metadata.
7. Query `/ready` through normal Railway HTTPS and compare its exact deployed
   SHA and startup-verified `buildManifest` with the independently attested
   candidate `treeSha` and `compiledSha256`, including the manifest's own hash.
8. Recheck the PR head and only then admit the bounded paid run.

Runtime environment strings or an HTTP SHA echo alone are insufficient: observed
Railway deployment identity and image/build proof must agree. The candidate must
contain this harness. Older branches without it need a reviewed rebase or
cherry-pick, which changes the SHA under test. A trusted overlay for arbitrary
historical commits is deferred.

Authentication protects `/ready`, `/runs`, `/acceptance`, `/usage` and `/stop`;
`/healthz` is the unauthenticated health probe. `/ready` provides readiness
identity without enabling provider calls. The controller carries the validation test bearer
through protected configuration, never printed commands or evidence. Run
admission binds the exact source/deployment and limits. There is one run per
deployment process. The controller executes the reviewed positive/negative
profiles, records sanitized evidence and attempts to stop only the deployment
whose exact owned ID it created. It retains the environment, service definition
and bound validation credential for future runs.

The manual workflow is dispatchable once its definition exists on the default
branch. Initial pre-merge operation must use the reviewed CLI orchestration,
rather than claiming that a feature-branch workflow has already run. Always use
the tested controller arguments and protected operator files;
there is no automatic paid retry or fallback admission.

## Initial pre-merge CLI operation

Use a clean reviewed controller checkout. Keep the target, artifact attestation,
archives and evidence outside that checkout, in operator directories with mode
`0700` and JSON files with mode `0600`. Supply `GITHUB_TOKEN` and
`RAILWAY_LIVE_VALIDATION_TOKEN` through the operator's credential mechanism;
the Railway token must be scoped to the validation project/environment. No
OpenAI key, signer or TLS private key is passed to the controller.

After credential-free checks at the exact candidate SHA, create `source.tar`
with `git archive --format=tar <exact-SHA>` and `build.tar` containing `dist`,
`packages/protocol/dist`, `packages/cli/dist`, `packages/arcanos-runtime/dist`,
`packages/arcanos-openai/dist` and `workers/dist`. Bind their actual SHA256 hashes
in `bootstrap-attestation.json` using these exact fields:

| Field | Required value |
| --- | --- |
| `version` | `arcanos-live-validation-operator-bootstrap/v1`. |
| `repository` | `pbjustin/Arcanos`. |
| `sourceCommit`, `prNumber`, `profile` | Exact candidate SHA, PR number and `gaming-guide`. |
| `trustedControllerSha` | Exact clean reviewed controller checkout SHA. |
| `treeSha` | Actual 40-hex candidate tree identity from `git rev-parse HEAD^{tree}`. |
| `compiledSha256` | Actual 64-hex compiled-directory digest from `validationDirectoryHash('dist')` in the reviewed `scripts/live-validation-bootstrap.mjs`. |
| `files` | Object containing only `source.tar` and `build.tar` mapped to actual 64-hex SHA256 digests. |
| `offlineGateRecords` | Exactly one actual successful record for every gate listed below. |

The schematic JSON shape is below. Replace every placeholder with verified
identity or the actual digest of retained evidence before use:

```json
{
  "version": "arcanos-live-validation-operator-bootstrap/v1",
  "repository": "pbjustin/Arcanos",
  "sourceCommit": "<exact-candidate-40-hex-SHA>",
  "prNumber": 1528,
  "profile": "gaming-guide",
  "trustedControllerSha": "<clean-reviewed-controller-40-hex-SHA>",
  "treeSha": "<actual-candidate-40-hex-tree-SHA>",
  "compiledSha256": "<actual-compiled-directory-64-hex-SHA256>",
  "files": {
    "source.tar": "<actual-source-archive-64-hex-SHA256>",
    "build.tar": "<actual-build-archive-64-hex-SHA256>"
  },
  "offlineGateRecords": [
    { "gate": "type-check", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-type-check-evidence-digest>" },
    { "gate": "lint", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-lint-evidence-digest>" },
    { "gate": "build", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-build-evidence-digest>" },
    { "gate": "railway", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-railway-evidence-digest>" },
    { "gate": "workflow", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-workflow-evidence-digest>" },
    { "gate": "secret-scan", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-scoped-scan-evidence-digest>" },
    { "gate": "service-auth", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-auth-evidence-digest>" },
    { "gate": "egress", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-containment-evidence-digest>" },
    { "gate": "exact-sha", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-image-proof-evidence-digest>" },
    { "gate": "gaming", "status": "PASS", "commitSha": "<candidate-SHA>", "evidenceSha256": "<actual-gaming-evidence-digest>" }
  ]
}
```

The ten gate IDs are `type-check`, `lint`, `build`, `railway`, `workflow`,
`secret-scan`, `service-auth`, `egress`, `exact-sha` and `gaming`. Each record has
only `gate`, `status: "PASS"`, the same candidate `commitSha`, and a nonzero actual
`evidenceSha256`. Keep the evidence being hashed; a fabricated PASS/digest is
not proof. The secret-scan record covers candidate additions and built output,
with separate safe historical triage; historical findings are not relabeled
as a clean full-history scan. The controller hashes archives as opaque bytes
and does not execute candidate code. Both bootstrap and hosted workflow
attestations bind the independent tree/compiled digests. Runtime startup
recomputes the compiled digest; readiness supplies the full manifest and its
hash, and the controller rejects a mismatch against those attested values.

The following preflight is offline and performs no paid call or deployment.
Set `LIVE_VALIDATION_REVIEWED_SHA` to the actual reviewed 40-hex head and
`LIVE_VALIDATION_ARTIFACT_DIRECTORY` to the protected archives directory:

```bash
node scripts/live-validation-controller.mjs --operator-bootstrap \
  --target-file /operator/live-validation/target.json \
  --artifact-attestation-file /operator/live-validation/bootstrap-attestation.json \
  --pr-number 1528 --commit-sha "$LIVE_VALIDATION_REVIEWED_SHA" \
  --profile gaming-guide \
  --max-spend-micro-usd 2000000 --max-provider-requests 32 \
  --max-workflows 2 --duration-ms 600000 \
  --evidence-dir /operator/live-validation/evidence
```

Only when the isolated environment, dedicated key and exact-SHA gates are ready,
the same authorized invocation gains `--execute --allow-paid-provider`. Both flags
are required together. Execution verifies the actual GitHub caller's maintainer
permission and successful exact-head `All Checks Complete`/`docs:check` checks;
draft PR status is allowed. The bootstrap route is forbidden inside Actions and
never serves as a fallback from failed workflow provenance.

Live selection may supply `--pr-number` alone to resolve its current head, or
`--commit-sha` alone to resolve its unique open same-repository PR. Ambiguous or
moved heads are rejected. Offline preflight requires both already resolved
values because it makes no GitHub request; the attestation must match them.
After the workflow exists on `main`, manual dispatch likewise accepts PR number
or exact SHA and defaults `paid_authorized` to false.

Cleanup uses the same protected target/evidence and resolved identities:

```bash
node scripts/live-validation-controller.mjs cleanup \
  --target-file /operator/live-validation/target.json \
  --pr-number 1528 --commit-sha "$LIVE_VALIDATION_REVIEWED_SHA" \
  --profile gaming-guide --evidence-dir /operator/live-validation/evidence
```

It reads back and stops only the exact deployment recorded as created by this
run. It retains the service/environment and provider binding. Preserve protected
state until cleanup succeeds; never publish `controller-state.private.json`.

## Paid-call limits

| Limit | Default hard maximum |
| --- | --- |
| Conservative reserved provider spend | USD 2.00 (`2_000_000` micro-USD). |
| Provider requests | 32, including charged metadata operations. |
| Workflows | 2: one positive, one negative. |
| Concurrent provider requests | 1. |
| Total test duration | 600,000 ms / 10 minutes. |
| Automatic retries | 0. |

Targets may tighten these limits. Provider admission reserves conservative input
and output token costs before each operation at the reviewed model price ceilings,
including every Trinity/audit stage. The USD 2 cap applies to those reservations;
understated ceilings cannot prove actual billed spend. Unknown model prices,
invalid usage, timeout, exhaustion or concurrency
violations fail closed. Failed or uncertain operations do not refund reservations.
No direct-answer regeneration or integrity-repair loop bypasses the quota.
Mandatory answer auditing and source/citation verification remain required even
when the remaining budget is small.

The provider path permits the reviewed textual Responses operations and model
metadata at fixed OpenAI endpoints, with storage/streaming/tools disabled,
no endpoint override, no redirects and no retries. The aggregate deadline also
bounds source and model work. An audit has its own measured stage status and
remaining budget; successful generation never substitutes for its completion.

Quota state is local to the one run in one deployment process. The service has
one replica and no automatic restart. A manual restart/redeployment can create
new process state; it is not authorization to repeat an exhausted run. Controller
run identity and deployment ownership prevent ordinary duplicate acceptance.
Durable accounting across process replacement is deferred. This is a reviewed
application facility, not an adversarial security broker isolating a provider
key from arbitrary candidate code. Use a dedicated validation provider project
with an account-side budget and reconcile billing. Conservative reservations
bound admission; they do not independently prove exact upstream billing or a
refund after cancellation. Railway build/hosting charges are separate.

## Gaming profiles and source protection

The reusable [live profiles](../examples/live-validation/profiles.json) define
both cases as data. [Fixture profiles](../examples/live-validation/fixture-profiles.json)
provide controlled offline evidence; their example origin is not a deployed
source host. Publisher reachability and usable coverage must be observed at
execution. No local fixture or anonymous URL check proves live acceptance.

| Profile | Required observations |
| --- | --- |
| `gaming-guide-positive` | Elden Ring, Samurai, immediately after tutorial, starting Uchigatana/early blade path, no explicit edition and ordinary advisory freshness. Real public acquisition succeeds; usable evidence is selected; meaningful coverage and any required clarification are recorded. Passing answer acceptance requires real Trinity execution, completed mandatory CLEAR audit, final `answer_ready`, admitted acquired-source citations, no durable source writes and no player persistence. |
| `gaming-guide-negative` | The Elden Ring request supplies an explicitly wrong-game Sekiro guide. The source is rejected/excluded, conflict reason is preserved, unsupported generation is withheld and durable writes remain zero. |

The adapter calls the existing v2 Gaming workflow. It forces `transient_only`,
fresh request actor scope, skipped stored retrieval and denied ingestion. It does
not initialize a production database, persist player progress, launch workers or
invent a separate Gaming engine. A clarification is preserved as an observed
result; it is not misreported as a generated audited answer. Missing noncritical
patch knowledge retains the ordinary visible freshness qualification.

Existing HTTPS-only public-source acquisition, DNS/IP-pinned SSRF protection,
private-network rejection, redirect policy, wire/decoded/text bounds, source-use
restrictions, instruction filtering, source compatibility, currentness, mandatory
audit and citation integrity stay enforced. Validation guards additionally deny
production/provider/internal destinations in the actual acquisition transport.
These are application controls. **No Railway-native domain egress ACL is claimed.**
Normal Railway HTTPS networking is used; there is no runtime-to-supervisor hop,
custom CA, certificate issuance, peer pin, signed supervisor session or private
verifier tunnel to provision.

## Sanitized stage evidence

Each live result distinguishes measured source acquisition, evidence selection,
generation, mandatory answer audit and response construction. Intake, reasoning
and final stages retain individual timing hooks where available. Evidence records
bounded timings, stage statuses, selected counts, semantic conflict/currentness
flags, audit completion/decision and final-answer fingerprint binding.
Unobserved stages remain unobserved; timing is never inferred from total latency.

The known production regression completed Trinity generation before the mandatory
Gaming answer audit timed out. A validation result must preserve that sequence:
`generation = completed`, `answer_audit = timed_out`, final acceptance failure.
It must not publish a final-looking answer as success when audit completion is
missing. Negative evidence must retain source conflict rather than relabeling it
as a provider failure.

Public artifacts contain exact source/deployment identity, compiled hashes,
profile/status fields, bounded provider counts/cost reservations and sanitized
stage evidence. They exclude prompts, source passages, answer prose, hidden
reasoning, chain-of-thought, credentials, raw provider errors and responses.
Citation evidence uses admitted source origins/document digests. Runtime stdout
and diagnostic files are private untrusted data, not public acceptance artifacts.

## Secret scanning and deferred work

Existing repository-wide secret scanning stays enabled. The historical scan at
starting SHA `9a511dd41f4fd7ce8412400c2b3b1dec8970cb08` reproduced 22 findings:
13 synthetic/test placeholders and 9 false positives, with no real credential
identified. The [audit](LIVE_VALIDATION_PR1528_AUDIT.md) records safe locations and
triage evidence. The full-history scanner still returns findings; it is not
reported as a clean PASS. Candidate additions and built output/image must also
be scanned. Historical repository cleanup is independent of this simplification
unless a real live exposure is discovered. No blanket ignore or reduced global
scan range is introduced.

Deferred work includes a separately trusted model broker, custom mTLS/CA/pins,
durable quotas across process replacement, a broader timeout/acquisition suite,
generalized module admission, typed semantic-gap contracts, trusted overlays for
old commits and independently enforceable network policy. These may add value in
a later threat model; none is a deployment prerequisite for this facility.

## Local verification and live status

Use the pinned Node `24.18.1` / npm `11.16.0` toolchain:

```bash
npm run test:live-pr-preview:offline
npm run test:live-validation:offline
node scripts/run-jest.mjs --runTestsByPath \
  tests/live-validation-gaming-adapter.test.ts tests/live-validation-source-guard.test.ts \
  tests/live-validation-isolation.test.ts tests/gaming-live-runtime.test.ts \
  tests/trinity-gaming-intake.test.ts \
  tests/trinity-integrity-recovery.test.ts --coverage=false
npm run type-check
npm run build
npm run lint
npm run validate:railway
npm run docs:check
npm run docs:links -- --local-only
git diff --check
```

Also run exact-SHA workflow, paid-call guard and Docker image verification, plus
redacted candidate/build/image secret scans. Mocked/local tests establish the
checked contracts only. Report actual Railway environment/service provisioning,
secret binding, exact-SHA deployment and each paid profile separately. Paid
calls must wait for the real isolated environment and dedicated secret binding.
A local success, dry run or source reachability check is not a live result.

This lane does not establish production deployment readiness, normal OAuth or
installed ChatGPT plugin acceptance, durable Gaming ingestion/retrieval,
Postgres/Redis behavior or human editorial review of a generated guide. It never
merges the PR or deploys to production.
