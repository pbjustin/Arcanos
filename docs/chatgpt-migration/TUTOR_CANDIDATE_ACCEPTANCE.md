# Tutor candidate acceptance checkpoint

Observation date: 2026-09-24 UTC. PR [#1509](https://github.com/pbjustin/Arcanos/pull/1509)
remains draft. The reconciled starting candidate was
`607b6424554ac412fd8d52901c3e0565165b5144`; base was
`3f9fffe48219b784dca758bca87ade109324c7c9`. The subsequent narrow arithmetic
repair is committed at **55798a8ee23a2464dea6c9fce15ca39ac90dd23d**. This is the
immutable tested source revision; the following evidence-only commit does not
change its runtime bytes. Freeze the exact selected commit again before any
future acceptance deployment. No candidate deployment or live
candidate request occurred in this phase. `CHATGPT_CANDIDATE_RETEST=PENDING`;
`MIGRATION_CHECKPOINT_READY=false`.

## Deployment discovery and approval boundary

Read-only Railway inventory and service configuration at approximately 06:30 UTC
identified one accessible project, Arcanos
(`7faf44e5-519c-4e73-8d7a-da9f389e6187`). Its non-production environments were:

| Environment | ID | Observed web startup |
| --- | --- | --- |
| Arcanos-pr-1433 | c88804be-b13b-46b0-b860-63304bdd5984 | integrity launcher with `--pr-preview-safe` |
| Arcanos-pr-1432 | 60dd64ed-a14c-4620-96be-fa91c110bb14 | integrity launcher with `--pr-preview-safe` |
| pr-preview-base-20260812 | 8d5594c5-075e-4ad5-8fad-9e6e0866032d | integrity launcher with `--pr-preview-safe` |

All are existing health-only previews, not an approved authenticated acceptance
target. Their web service is `c4ade025-3f13-4fca-9309-5d0dd81396fe`.
No environment was adopted, modified, or provisioned. Variable values were not
read. Native sealed previews must retain their credential-free mock contract.

The owner was asked to approve this specific proposed setup; approval is pending:

- New Railway project `arcanos-tutor-acceptance-1509`, environment `acceptance`,
  one web service and one replica; no database, Redis, volume or worker, and no
  copied production variables. Project/environment/service IDs do not exist yet.
- Proposed endpoint and exact OAuth resource audience:
  `https://arcanos-tutor-acceptance-1509.up.railway.app/chatgpt/mcp`.
  This name is unassigned. Verify its availability and assignment before auth
  setup; a different host needs a revised explicit resource binding.
- Separate Auth0 development tenant, API and public authorization-code/PKCE
  client, restricted to the owner's test account and only `arcanos:tutor`.
  Copy the exact callback shown by the new ChatGPT test connection; do not guess
  it or alter production Auth0 policies. No paid Auth0 plan/upgrade is proposed.
- Dedicated test-provider credential provisioned through approved secret controls,
  never chat or a copied production environment. Startup also requires a separate
  candidate-only job-read capability secret on Railway; this prerequisite does
  not grant a Tutor job tool. No secret has been created or supplied.
- Two-hour lifetime, at most six Tutor requests, provider spending allowance up
  to USD 5. Actual provider charges depend on model and pipeline usage; verify
  usable budget controls before execution. At 2 GB RAM and one continuously busy
  vCPU for two hours, published Railway container rates imply about USD 0.12 plus
  egress, excluding the existing subscription. No new subscription is authorized.
- Remove only the new test project, auth resources, dedicated credential and
  ChatGPT test connection after evidence capture. Any retention for an owner
  handoff needs approval. Never remove the working production connection.

The setup decision is required by the owner's explicit authorization boundary,
not by a repository validation failure. No production fallback is permitted.
Pricing basis, accessed 2026-09-24:
[Railway container pricing](https://docs.railway.com/pricing/plans).

## Startup constraints to verify before any deployment

The canonical integrity launcher and actual application are required. Do not
replace OAuth, provider admission or generation with a preview executor.
Source review found that the `web` process role suppresses workers and self-heal
loops. Normal startup still calls dependency initialization; complete absence of
database configuration is required to avoid database/network/schema work.
Session persistence, Notion, Redis, operator, bridge and disk-content logging
configuration must be absent or explicitly disabled as their contracts require.
The ordinary application still mounts other HTTP routes; only its tested MCP
catalog is Tutor-only. Verify the candidate's actual access and network boundaries
before calling this an isolated deployment.

Production mode requires a Redis-backed public-provider rate store. A proposed
Redis-free acceptance service therefore needs an explicitly reviewed development
profile with an in-memory rate store, single replica and fixed lifetime.
`NODE_ENV=staging` is not supported. Development mode reflects origins in the
global app CORS layer; the MCP router still independently rejects any supplied
Origin except its canonical resource origin. In-memory counters reset on restart.
This profile is not evidence of production distributed-counter behavior.

MCP signature/issuer/audience/expiry/scope checks, its 120/minute IP and
30/minute principal limits, shared provider admission, runtime safety and
60-second timeout remain enforced by source inspection. The isolated Tutor
policy disables memory and optional persistence. Missing provider configuration
must never be treated as successful model acceptance; reject mock/shortcut
results and corroborate real pipeline execution. Source inspection is not a
startup test: inspect the exact approved configuration and startup result first.
Require `OPENAI_API_KEY_REQUIRED=true`, explicit mock flags off, a public bind,
and a dedicated `ARCANOS_JOB_READ_CAPABILITY_SECRET` through secret controls.

Deploy an immutable reviewed commit only after setup approval. Record actual
project/environment/service/deployment IDs and revision, require terminal
SUCCESS, runtime revision, readiness, exact protected-resource metadata and
anonymous HTTP 401 before authenticated generation.

## Predeclared bounded live tests — not executed

Use the real MCP SDK for initialize, initialized notification and tools/list.
Require exactly `arcanos_tutor`, the candidate's canonical prompt-only schema,
OAuth scope `arcanos:tutor` and the unchanged output schema. Test large and invalid
boundary payloads in deterministic fixtures, not against the live provider.

Planned generation order is one direct SDK Test A, followed by ChatGPT Tests
A–D: five requests total. The sixth request is unallocated, not an automatic
retry allowance. Stop on an unexplained failure; retain every attempt. Keep
approved provider budgets even when one Tutor request invokes multiple stages.

| Test | Exact prompt |
| --- | --- |
| A | Explain why one half equals two quarters, in two short sentences. |
| B | `Explain why 1/2 equals 2/4.\nUse exactly two short sentences and no heading.` |
| C | In exactly two sentences, explain why 1/2 equals 2/4 and ask the learner to check the equality by cross-multiplying. |
| D | Give exactly three numbered steps to solve 2x + 3 = 9, with no introduction. |

For B, replace the displayed `\n` with an actual newline. Refresh only the new
acceptance connection, inspect the updated schema/catalog, and start a new chat
with that connection explicitly selected. Never repoint the production app.

Store exact inputs, raw MCP answers and displayed ChatGPT answers separately
inside `.local-migration/arcanos-tutor/`. Record revision, environment, UTC time,
safe execution provenance, tool selection, format, correctness and any error.
Publish only reviewed sanitized summaries and hashes. A correct raw answer with
an incorrect displayed answer is a presentation failure; an incorrect raw answer
is a backend failure; pre-backend schema rejection or a forbidden/unavailable tool
is a client-surface failure. Unavailable evidence remains pending. Do not edit,
truncate or rewrite answers to turn failures into passes.

## Published baseline and account handoff

At approximately 06:38 UTC supported owner UI still showed Live / Only me and
Current version dated Mar 5, 2026. The editor also displayed Last edited Sep 24.
Neither label establishes the exact latest-published timestamp or that editable
fields have no unpublished changes. No GPT configuration was changed.

The required private `published-gpt.json` is absent. The existing capture command
failed closed with exit 1 / `BASELINE_INVALID`; no review output was created or
overwritten. Supply the actual published fields listed in
[TUTOR_INPUTS.md](TUTOR_INPUTS.md), complete non-secret Action schemas, publication
provenance and owner confirmation, plus the complete knowledge inventory and
original file bytes. Unknown knowledge count is not a confirmed empty inventory.

The ten earlier observations remain unbound; independent review recomputed their
summary hashes and all sixteen prompt hashes. Official count is **0/16**.
Reusing them requires proof that the captured published configuration was in
effect at each observation, otherwise rerun after capture. Six cases remain
unexecuted; failure cases need isolated procedures and reference use needs the
inventory. All migrated-plugin results remain absent.

## Evidence separation and release order

| Evidence domain | Revision/environment | Current result |
| --- | --- | --- |
| Candidate repository tests | 55798a8ee23a2464dea6c9fce15ca39ac90dd23d; isolated local worktree | 465 unique tests PASS, 0 fail, 0 skip |
| Candidate authenticated deployment | No environment/deployment | BLOCKED on setup approval and verified isolation |
| Candidate authenticated SDK | No environment/deployment | NOT_STARTED; 0 live requests |
| Candidate ChatGPT | No separate test connection | PENDING; raw/final comparison unavailable |
| Existing production | 3f9fffe48219b784dca758bca87ade109324c7c9; production | SUCCESS plus fresh public metadata/401; not candidate proof |
| Historical sealed preview | 7f4e8c6de2ad145be04de23a436a2dc106f118e7; removed environment | Hosted and independent 156/156 each; synthetic only |
| Published GPT/old observations | Published fingerprint unavailable; owner's original GPT | BLOCKED; 10 unbound observations, 0/16 official cases |
| Actual migrated skill/references/parity | No artifacts/revision | NOT_STARTED/BLOCKED |

The 465 local tests are 410 tests in thirteen focused suites plus 55 tests in four
distinct protocol suites. The earlier 407-test run, 17-test repair run and
negative control are not added again. The three legacy-route cases use the actual
router with mocked dispatch; they do not verify a live durable queue. The 40 MCP
and 103 auth cases cover the schema/auth negatives; remaining focused suites
cover provider failure, timeout/disconnect, isolation and honesty. Type-check,
build, CLI contract/offline and lint passed (0 lint errors, 76 existing warnings).
Source package validation passed; release validation remains expected exit 2 /
`RELEASE_BLOCKED`, with no archive. Baseline capture exit 1 is an expected missing
input block, not a successful capture. Final-head hosted checks are recorded in
the PR after push, separately from these local results.

At approximately 06:40 UTC, Railway production still reported SUCCESS for web
deployment `e14cfd48-0075-4996-b0dd-ec7b620d5d82` at base revision
`3f9fffe48219b784dca758bca87ade109324c7c9`, environment
`fb583147-6c39-4343-9267-500f357d25ab`. Public metadata returned the production
resource and only `arcanos:tutor`; anonymous MCP returned 401. This is not candidate
deployment, authenticated candidate discovery or candidate formatting evidence.
The production app mapping is unchanged. Its account catalog was not refreshed
again in this phase; the earlier 04:32 UTC observation remains dated evidence.

Historical sealed-preview results remain hosted **156/156 PASS** and independent
**156/156 PASS** at `7f4e8c6de2ad145be04de23a436a2dc106f118e7`. They predate all
current runtime repairs and do not verify migrated-skill behavior. Fresh inventory
still excludes the task-owned preview environment and both former hosts return
404. No new cloud resources require cleanup; the temporary account inspection tab
was closed. Private review files are preserved.

Recommendation: **KEEP #1509 DRAFT**. Live candidate acceptance and the published
baseline remain blocked. Backend proof does not require account migration.
If live acceptance later passes, an owner-approved backend-only split could
contain these exact files, plus regenerated indexes if required:

- `src/core/logic/trinity.ts`, `trinityHonesty.ts`, `trinityTypes.ts`, `tutor-logic.ts`
- `packages/protocol/schemas/v1/tools/arcanos-tutor.input.schema.json`
- `tests/chatgpt-tutor.pipeline.test.ts`, `chatgpt-mcp.integration.test.ts`,
  `tutor-instructional-verification.test.ts`, `tutor-migration-legacy.test.ts`
- `docs/SCHEMA_PROTOCOL_GUIDE.md`

These fixes depend on the Tutor MCP foundation already in base #1508; no new
package, database migration, or private migration artifact is required. All
plugin packaging, capture/release tooling, private-artifact reviews, parity and
migration gates stay in #1509. Do not create the split without approval.
After separate merge/production authorization, follow the maintained production
workflow's worker-first checks before web promotion and refresh the catalog only
after the web revision is verified. A separately authorized rollback restores
the prior approved runtime and catalog; it also restores the known old schema/
format limitations. Neither deployment nor rollback changes the GPT account.

## Official requirements rechecked on 2026-09-24

- [MCP authentication](https://developers.openai.com/plugins/build/auth): exact
  resource/audience binding, per-request token validation, discovery, S256 PKCE
  and the actual connection callback; no borrowed production audience.
- [Connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt):
  inspect schemas and results, refresh after metadata changes, then use a new
  conversation. SDK and installed-plugin testing are separate stages.
- [Migration FAQ](https://help.openai.com/en/articles/20001519-custom-gpt-retirement-and-migration-faq):
  latest published configuration transfers; drafts and custom Actions do not.
  Review the resulting skill/references; the replacement starts private and
  is not automatically installed. Original GPT editability is not reversible
  through a repository rollback.
- [MCP platform availability](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt):
  custom MCP apps are documented as web-only on mobile. The owner's iOS connection
  error remains USER_REPORTED. `IOS_VERIFIED=BLOCKED_BY_PLATFORM`; no backend
  remediation is indicated for that documented platform limitation. This does
  not diagnose every possible cause of the reported device error.

These documents do not establish this account's acceptance-connection eligibility.
No migration, final installation, publication, merge or production promotion is
authorized by this report.
