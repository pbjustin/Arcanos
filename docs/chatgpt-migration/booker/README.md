# Backstage Booker private plugin migration

This is Slice A of [Issue #1565](https://github.com/pbjustin/Arcanos/issues/1565):
the Booker-specific backend MCP boundary and reviewable domain instructions.
It is not evidence of a completed plugin migration or an installed connection.
The implementation base includes merged authority-wait PR #1562.

## Architecture and parity assessment

The existing backend remains the execution authority. A dedicated OAuth
resource authenticates a separately registered client and one configured
owner/universe pair. Seven closed tools reuse existing run-action routing,
protected durable jobs, sanitized result continuation and exact read services.
No new backend, database schema, provider constructor or infrastructure service
is required. Legacy Custom GPT routes, saved bearer and canon writes retain
their existing contracts.

| Existing capability | Slice A disposition | Preserved behavior |
| --- | --- | --- |
| `runBackstageBooker.queryContinuity` | WRAP as `queryContinuity` | Exact pageTitle/pagePath/sectionPath/subtree scope; relevant/complete_scope retrieval; immutable snapshot cursor; coverage, omissions and truncation; no legacy fallback. |
| `runBackstageBooker.generateBooking` | WRAP as `generateBooking` | Kay "Spotlight" Morales, complete requested creative task, mandatory server CLEAR, existing synchronous/queued policy, protected authority and output. |
| `runBackstageBooker.generateBookingWithHRC` | WRAP as `generateBookingWithHRC` | Same generation plus existing HRC fidelity, resilience and verdict. |
| `runBackstageBooker.simulateMatch` | WRAP as `simulateMatch` | Original ratings, randomness, modifier, interference and HRC; explicit numeric roster under Notion authority; no canon promotion. |
| `getBackstageUniverse` | REUSE through exact authorized wrapper | Bounded PostgreSQL snapshot, missing-data and truncation truth; Notion-authoritative legacy-read quarantine. |
| `getBackstageStoryline` | REUSE through exact authorized wrapper | Exact key, Unicode offsets, expectedVersion conflict fence, same quarantine. |
| `getBackstageBookerJobResult` | REUSE protected result core | Stable owner/universe job scope; same-job bounded wait; authenticated unseal; protected completion provenance; no provider replay. |
| `writeBackstageCanon` | BLOCKED, no MCP tool | Separate approval/authorization design and implementation required. |
| Other module/operator actions | DEFER, inaccessible | No generic dispatch, operator, administration, global discovery or direct database/Notion tools. |

The [Custom GPT guide](../../BACKSTAGE_BOOKER_CUSTOM_GPT.md),
[Builder instructions](../../BACKSTAGE_BOOKER_GPT_BUILDER_INSTRUCTIONS.md),
[OpenAPI contract](../../../contracts/backstage_booker.openapi.v1.json) and
[migration inventory](../INVENTORY.md) are the repository parity baseline.
The source [Booker skill](skills/backstage-booker/SKILL.md) translates that
workflow into dedicated tool calls. The original private GPT's full saved text,
knowledge uploads, conversation starters and account configuration have not
been captured or reconciled; full behavioral/knowledge parity remains unproven.

## Security and continuation

Every tool needs `arcanos:booker:read`; generation, HRC and simulation also need
`arcanos:booker:generate`. A verified subject is authorized only for the exact
server-configured universe. The universe ID is never authentication. Subject,
issuer, audience, client registration, expiry and scopes are checked; no legacy
bearer or cross-resource identity is accepted. The stable job actor includes
issuer, subject and universe, and result reads verify the protected universe.

Generation retains current-complete Notion admission, durable authority waiting,
payload protection, cancellation, queue claims, budgets, idempotency and final
provenance. Neither discovery nor polling dispatches new inference. Once a job
ID is known, continue that same job while pending. An initial pre-response
transport abort permits one identical retry; changed prompts, keys or requests
are not result lookup. No protected backend failure permits invented continuity,
partial official booking or local fallback.

## Live OAuth and private ChatGPT acceptance plan

**Draft plan; no live steps executed by preparing this document.** The source
baseline is [PR #1566](https://github.com/pbjustin/Arcanos/pull/1566) at
`19a7ab850c8ff06e86e4bb5fa8e667a081841eb4`. Refresh that identity, required CI
and review state before any execution; a different deployed revision needs its
own evidence. Keep the PR draft and the existing Custom GPT intact. Green CI,
an HTTPS endpoint, health success or an uploaded package cannot establish live
OAuth, provider, Notion, private-client or full migration acceptance.

### Execution boundaries and prerequisites

This plan authorizes no deployment, account/configuration change, installation,
provider call, credential rotation, publication or merge. Future approval must
identify the exact action, owner, project/environment/service, source/artifact
revision, affected data and expected effect, limits and rollback. Merge is a
separate decision and is not required to plan an isolated branch acceptance run.

| Stage | Required before execution | Effects to approve separately |
| --- | --- | --- |
| Target preparation | Select an existing suitable isolated target, exact web/worker revisions, HTTPS origin, approved issuer and test owner/universe. Inventory current configuration without exporting values. | Any branch deployment, enabling Booker, OAuth registration/configuration, worker activity and existing startup database writes. No production target is implied. |
| OAuth/transport | Approve the exact issuer/client and controlled accounts, scopes, token lifetime and test cases below. Establish provider/API cost and request limits. | Sign-in/consent, scoped metadata/MCP requests and negative authorization tests. No generation or Notion synchronization by implication. |
| Private installation | Verify endpoint/metadata and pre-link auth checks; reconcile instruction/knowledge inputs and select the intended personal account or workspace. | Create or update one private candidate, upload if needed, finish actual callback/client binding, install and connect it. No sharing, public listing, publication or Custom GPT migration action. |
| Functional acceptance | Approve fixtures, Notion read access, provider budget, test sessions, job processing and permitted backend persistence. | The listed continuity/generation/HRC/simulation calls, result polls and evidence reads. Fault scenarios require an explicitly isolated target. |
| Stop/rollback | Record the exact candidate and independently scoped client/resource plus accepted-job reconciliation procedure. | Disconnect/uninstall the candidate or disable Booker through the approved configuration path. No shared credential rotation, production change or deletion of jobs/data. |

Reuse the existing backend and operational paths. Do not create an authorization
server or infrastructure service just to run acceptance. Protected generation
needs the existing Notion synchronization, current-complete snapshot, durable
jobs/admission and matching web/worker payload protection. Verify those settings
by secure configuration references; never print/copy the payload key or Builder
bearer. An isolated non-Notion fixture is separately needed for successful
legacy state reads. Without a fixture or approved fault mechanism, mark that
case **NOT VERIFIED**; do not weaken quarantine or disrupt production to pass it.

### OAuth registration and configuration contract

ChatGPT is the OAuth client, ARCANOS is the resource server, and an approved
identity provider is the authorization server. This PR supplies token validation
and protected-resource metadata; it supplies no authorization, token,
registration, refresh or revocation endpoints. Confirm issuer compatibility
before enabling the resource. Follow [official OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth).

Record these settings through secure configuration references, with no actual
owner identity, universe mapping or credentials in a plugin or committed report:

| Setting | Acceptance requirement |
| --- | --- |
| `CHATGPT_BOOKER_ENABLED` | Remains disabled until the approved target is ready; only exact `true` enables it. Disabled returns 404, incomplete enabled configuration returns 503. |
| `CHATGPT_BOOKER_ISSUER` | Exact approved HTTPS issuer, matching authorization-server discovery and token `iss`. |
| `CHATGPT_BOOKER_RESOURCE` | Exact HTTPS origin plus `/chatgpt/booker/mcp`, with no trailing slash; OAuth `resource` and the token's scalar `aud` must match it exactly. |
| `CHATGPT_BOOKER_JWKS_URL` | Approved HTTPS endpoint for access-token signing keys. Verify it belongs to the selected issuer/configuration. |
| `CHATGPT_BOOKER_OAUTH_CLIENT_ID` | Exact independent Booker client identity, also present in signed `client_id` or `azp`. If both claims occur, both must match. |
| `CHATGPT_BOOKER_OWNER_SUBJECT` | Exact verified owner `sub`; display name, email, a caller/session string or a universe claim does not grant ownership. |
| `CHATGPT_BOOKER_UNIVERSE_ID` | One exact server-authorized universe, never a wildcard or caller-selected membership. |

Prefer an independently predefined Booker OAuth client when the approved issuer
supports it. CIMD or DCR is an alternative only after verifying compatibility
and binding the actual resulting client identity to the same configuration;
do not invent a client ID or assume a shared Tutor/Gaming registration suffices.
Use the actual ChatGPT management page's redirect URI, allowlisted exactly.
Callback mode depends on the issuer's advertised issuer-identification support;
do not guess a callback URL, allow a wildcard or advertise unsupported features.
If that management page becomes available only after private candidate creation,
perform the separately approved creation step, finish callback/client binding,
then return to OAuth verification before functional calls. Creation alone is
not a successful connection.

The authorization server must advertise authorization-code flow, PKCE `S256`,
authorization/token endpoints and supported token-endpoint authentication.
Verify `resource` through authorization and token exchange. Any advertised OIDC
scopes must be enabled for that client. Check the actual access token securely:
`typ: at+jwt`, RS256/ES256, valid signature, exact `iss`, scalar `aud`, owner
`sub`, signed client binding and integer `iat`/`exp`; future issue time and
audience arrays are rejected. Synchronize clocks: the verifier grants no clock
tolerance. Opaque tokens and ID tokens cannot substitute for access tokens.

Grant `arcanos:booker:read` independently of `arcanos:booker:generate`. Every
request needs read; generation/HRC/simulation need both. Generation-only or
Tutor/Gaming/operator scopes grant no Booker access. Extra unrelated scopes
do not expand permissions. Select a short token lifetime with enough remaining
time for a 60-second operation or 35-second result transport (wait up to 30
seconds), and record the maximum residual access window after grant revocation.

### OAuth and transport acceptance

Run direct protocol checks with an approved MCP client/Inspector before private
ChatGPT linking where possible; real ChatGPT linking and scope-upgrade cases
follow private installation. Positive direct checks need legitimately issued
tokens bound to the configured Booker client. An Inspector's different client
is not authorized automatically; do not extract ChatGPT-managed credentials or
weaken client binding to make it work. If only ChatGPT can complete the approved
flow, retain pre-link positive cases as pending until that connection exists.
Use only the selected test identities and approved negative fixtures. Capture
response classes and redacted claim assertions, never tokens,
authorization codes, cookies, secrets or complete OAuth redirects/HAR files.

| ID | Case | Required result |
| --- | --- | --- |
| O1 | Fetch `/.well-known/oauth-protected-resource/chatgpt/booker/mcp`; call MCP anonymously. | Metadata advertises only the exact resource, issuer, two Booker scopes and header bearer method; no owner/universe disclosure. Anonymous MCP returns 401 with the matching `WWW-Authenticate` metadata challenge. No provider execution. |
| O2 | Sign in/consent with the owner; test consent denial, state mismatch, wrong PKCE verifier and code reuse using approved client/issuer fixtures. | The client rejects mismatched state before exchange; the issuer rejects wrong verifiers/code replay and honors consent denial. Distinguish actual client state handling, issuer enforcement and backend JWT verification; a mocked client is not ChatGPT evidence. |
| O3 | Initialize/list/call via authenticated POST and stateless JSON responses. | Read-only grant lists exactly four tools; both scopes list exactly seven. Read-only generation yields MCP `BOOKER_PERMISSION_DENIED` with `mcp/www_authenticate`; actual ChatGPT scope upgrade/reconnect works. No anonymous/mixed-auth workaround. |
| O4 | Missing/duplicate/malformed bearer; wrong signature, issuer, audience, owner/client; conflicting client claims; expired/future token, ID token or unsupported algorithm; missing read/unrelated-only scopes and legacy credentials. | Authentication/scope rejection before protected execution. No access granted by token universe hints. Use valid issuer-issued negative fixtures where needed; unit-token tests alone are not live issuer evidence. |
| O5 | For every tool, another universe/case-changed ID, forged membership/session/actor/write fields and unadvertised canon/admin tool names. | Closed-schema or permission denial; no cross-universe read, wait, unseal, provider admission or mutation. Check MCP errors as well as HTTP status. |
| O6 | Foreign Origin, unsupported methods/batch, oversized body, malformed/empty JSON, invalid UTF-8 and UTF-16; valid multibyte control. | Foreign Origin returns 403; authenticated GET streaming returns 405. Body cap is 256 KiB; invalid JSON/UTF-8 returns 400, unsupported media/charset 415, oversized 413. Valid Unicode survives exactly. No provider work for invalid requests. |
| O7 | Renew token, reconnect, expire it, revoke grant and attempt refresh/fresh relink. | Renewed owner identity preserves job access. Expired JWTs fail; refresh using a revoked grant is denied. Fresh owner sign-in/consent may legitimately issue a new grant under issuer policy. Record actual residual validity of an already-issued JWT. |
| O8 | Unknown signing key/JWKS failure on an isolated issuer fixture. | Unknown/unverifiable keys fail closed. Existing valid cached keys may still verify: current cache is 600 seconds, cooldown 30 seconds, fetch timeout 3 seconds. Record cache state; do not claim every issuer outage immediately invalidates tokens. |

The resource does not introspect tokens or maintain a revocation list. Immediate
revocation of an otherwise valid JWT is **not implemented**. Do not call expiry
or refresh denial proof of instant access-token revocation. If acceptance needs
that stronger guarantee, stop and propose a separate reviewed change.

The actual ChatGPT transport must send no `Origin` or the exact resource origin;
other origins are denied. Verify this during linking rather than relaxing the
boundary speculatively. Metadata/HTTP challenges bootstrap whole-server OAuth;
tool-level scope challenges also require the existing per-tool security metadata.

### Private candidate and behavior acceptance

After separately authorized endpoint verification, capture the original private
GPT's saved instructions, uploads, starters and relevant settings by an approved
read-only process. Reconcile them with the repository baseline and source skill;
retain private inputs outside tracked files and record only sanitized hashes or
review conclusions. Do not press migration controls or modify/invoke the existing
GPT as an incidental test. Any paired baseline execution needs its own approved
provider/persistence scope. Missing artifacts keep full parity **NOT VERIFIED**.

Prepare one candidate with the reconciled skill and verified Streamable HTTP
endpoint in `mcp.json`; authentication settings use the actual registration.
Validate package contents and hashes without embedding secrets or private owner
mapping. Inspect the account for the intended Booker candidate before creating
anything; reuse its identity on retries and retain plugin/release IDs privately.
Creation, upload, installation and OAuth connection are separate evidence steps.
Public publication/sharing is unnecessary for private acceptance and remains
outside this plan. Follow the current [custom MCP connection guidance](https://developers.openai.com/api/docs/guides/custom-mcp-server)
and confirm the actual account/workspace permits the chosen private flow.

Test in a fresh ChatGPT web conversation with only the intended Booker candidate
selected. Inspect actual tool inputs/outputs and the assistant's final answer.
For each tool, exercise an explicit tool request and an ordinary booking question
that should select it; include negative prompts for canon writes, cross-universe
access, bypassing CLEAR, invented continuity and local replacement after failure.
The packaged skill must be present and active; bare MCP connectivity cannot prove
instruction/knowledge parity. Test iOS separately if the installed candidate is
available there; account/platform availability and on-device behavior remain
**NOT VERIFIED** until observed, even when web passes.

| ID | Tool or behavior | Required result and evidence |
| --- | --- | --- |
| B1 | `queryContinuity`: known facts, exact page/path/section/subtree, duplicate titles and blank navigation parents. | Facts match an independently inspected approved Notion fixture; exact scope excludes siblings, ambiguity is explicit, source text remains untrusted. Preserve provenance, omissions and truncation. It stays inline; read scope may still invoke paid synthesis. |
| B2 | `complete_scope` pagination and changed/superseded cursor. | Start cursor-free; follow unchanged query/scope/mode/universe through `hasMore:false`. Do not sum omitted counts or call a sampled page exhaustive. Invalid cursor discards accumulated pages; restart without mixing snapshots. Retrieval coverage alone does not prove complete delivered prose. |
| B3 | Current-complete, last-known-good and unavailable/partial authority. | A labeled last-known-good continuity read may succeed; protected generation requires current-complete authority. Approved stale/incomplete fixture waits or fails under the existing policy. No PostgreSQL, memory or other-universe fallback. Health/status 200 is not proof of eligible authority. |
| B4 | `generateBooking`: one complete card/task with approved show, match count, roster, stipulations, tone and format. | Kay "Spotlight" Morales voice, all requested components and grounded continuity; backend evidence of existing CLEAR and protected completion provenance. No client call to apply CLEAR, exposed internal scores, partial/truncated card called complete or proposal promoted to canon. |
| B5 | `generateBookingWithHRC`. | Same protected creative behavior plus the existing HRC fidelity/resilience/verdict. Treat HRC as critique, not canon verification. Compare required behavior with the approved baseline, not byte-identical creative prose. |
| B6 | `simulateMatch`: normal/kayfabe shapes and missing numeric roster. | In a Notion universe require explicit numeric ratings; preserve modifiers/interference and existing randomized result/HRC. Missing ratings reject without legacy fallback. Do not require one predetermined winner or claim statistical validation from a small sample. Simulation establishes no confirmed result/canon write. |
| B7 | `getBackstageUniverse` and `getBackstageStoryline` on the Notion target. | Expected `BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED` (wrapped 409), with no fallback. A successful legacy PostgreSQL read here would fail acceptance. |
| B8 | The two state readers on a separately approved non-Notion fixture. | Exact bounded universe and truthful missing/truncated data; `hasPersistedData:false` does not prove nonexistent universe. Storyline key preserves Unicode/case/punctuation; concatenate pages exactly using offsets and page-zero version. Keep null distinct from empty text; version conflict discards traversal. Never switch universe IDs to escape the current binding. |
| B9 | Queued booking and `getBackstageBookerJobResult` through pending/completed, renewal and reconnect. | Preserve the accepted job ID, same owner/universe and protected completion provenance. Use only the MCP result tool (default wait 30000 ms), never legacy poll URLs/read tokens. Foreign owner/universe/job reveals no result. Pending is not a failed or official completed booking. |
| B10 | Initial response loss, duplicate idempotency key and changed request. | One controlled pre-response retry uses the identical request/key and recovers the same logical job; changed payload with the same key conflicts. After any accepted job ID, no generation retry. Measure provider/job lineage before/after repeated polls/reconnect: zero new generation submissions or provider dispatch caused by continuation. Legitimate CLEAR/HRC/recovery stages may involve multiple provider calls. |
| B11 | Isolated timeout/cancellation, failed/cancelled/expired/not-found/unavailable/unverified result, output-incomplete or protected authority/provider failure. | Preserve `{statusCode,result}`, lifecycle and authority flags; HTTP 200 alone is insufficient. No official/partial replacement card, fabricated canon, guessed provider diagnosis or alternate-plugin fallback. `official:false` or `protectedGenerationCompleted:false` never becomes success. Pending stays pending. |
| B12 | Write requests and malicious instructions inside retrieved content. | No canon/admin/operator tool or alternate compatibility route is invoked. Approved before/after universe/canon revision observations show no canon mutation; existing durable job, admission and permitted operational persistence remain intact. Do not describe the whole backend workflow as having zero writes. |

Continuity and simulation retain the existing generic response projection,
including 4 KiB string previews and source/path pruning. Inspect for
`...[truncated]` even when retrieval coverage is exhaustive; marked prose cannot
pass a full-answer assertion. Protected generation bypasses that string-preview
projection and fails closed on protected whole-payload overflow instead.

When no accepted pending or verified completed protected booking result is
recovered, the assistant must use the source skill's failure statement:
"The protected Backstage booking did not complete, so no
official result was established." Then stop; no unrequested degraded draft.
Generation after a backend failure is never an automatic recovery step. Any
explicitly requested conversation-only degraded mode remains separately labeled
unofficial and cannot satisfy protected generation acceptance.

### Evidence, stop conditions and sign-off

Create a redacted case ledger before running, with O1-O8 and B1-B12 initially
**NOT RUN**. Approval must fill in maximum initial tasks, paid calls/cost,
pagination requests, result polls and wall-clock duration; run one task at a
time. Stop at the first approved limit, preserve pending jobs and never submit
replacement generation to finish a matrix. For each record retain: UTC time,
executor, source/deployed/artifact
revision and target identity, private candidate/release hash reference, fixture
and baseline revision, expected result, actual HTTP/MCP/wrapped result, authority
freshness/coverage, stage/job lineage, expected/observed side effects, evidence
reference and **PASS**, **FAIL**, **BLOCKED** or **NOT VERIFIED** with a reason.
Keep web, iOS, issuer, provider, Notion, database and worker evidence distinct.
Store protected payloads privately; commit only approved redactions/hashes.
Never commit token/code/cookie/secret values, raw personal continuity, session or
job/actor identifiers, private GPT uploads or full network traces.

Use existing approved structured correlation, job/provider records and bounded
reads for evidence. If those cannot demonstrate lineage or absence of a canon
mutation, mark the assertion unverified and propose the smallest evidence gap
repair. Do not enable prompt tracing, raw SQL access or new plugin diagnostics
as an incidental shortcut. Operator authority-status inspection belongs to its
separately authenticated control plane, outside the seven-tool catalog.

Stop paid/functional tests on unauthorized access, canon mutation, duplicate
generation, leaked credentials/private data, mixed snapshots, fabricated official
output or lost protected provenance. Preserve redacted evidence and report the
failed invariant. Reconcile accepted jobs before retrying, disconnecting or
disabling anything; a timeout/disconnect can leave backend work running.
An approved rollback must account for that work and configuration captured at
router startup. Disabling the resource does not cancel jobs. Existing Custom GPT
availability and its credentials must remain unchanged throughout acceptance.

Current live status is **NOT RUN**: approved target/configuration, issuer flow,
private package/install, private GPT baseline reconciliation, actual provider/
Notion/worker completion and installed-client behavior have not been established
by this plan. Accept a layer only with its own evidence. Required parity cases
that are failed, blocked or unverified prevent a full migration acceptance claim;
document any explicitly agreed scope limitation. Even a passing private trial
does not authorize merge, production promotion, publication or canon writes.

## Next slice: protected canon writes

Design only `upsertStoryline` and `appendCanonBeat`. Require verified exact
universe membership, a separate write scope and a server-verifiable approval
bound to the normalized mutation, principal, universe and expiry. A chat
instruction or consequential annotation alone is insufficient authorization.
Preserve `mutationId` idempotency, `expectedVersion` conflicts, exact duplicate
retry and receipt-based unknown-outcome reconciliation. Denial sends no write;
an unknown outcome must reconcile before resubmission. Never write to a
Notion-authoritative universe. Add cross-user, denied/expired/replayed approval,
scope, version, conflicting-idempotency and lost-response tests in a separate PR.

Until that design is reviewed and implemented, canon writes stay inaccessible
through Booker MCP. Existing backend writes are unchanged.
