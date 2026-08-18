# Backstage Booker Custom GPT

This is the Builder-facing configuration for the existing **Backstage Booker**
Custom GPT. It adds narrow authenticated exact-universe and exact-storyline
reads plus a
canon-writing lane with one visible ChatGPT consequential-action approval
instead of a second, time-limited backend confirmation challenge. The same
Action credential can also establish request-local authorization for optional
read-only Notion context during booking generation; Notion adds no operation.

## Action configuration

- Import schema: `https://acranos-production.up.railway.app/contracts/backstage_booker.openapi.v1.json`
- Repository contract: [`contracts/backstage_booker.openapi.v1.json`](../contracts/backstage_booker.openapi.v1.json)
- Schema version: `1.2.0`
- Canonical server: `https://acranos-production.up.railway.app`
- Authentication: in ChatGPT Builder select **API Key**, then **Bearer**. Enter
  only the dedicated `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` value. This is a
  static purpose-bound Action credential, not OAuth and not a user's password.
- Secret placement: store the value only in the Railway web service and
  ChatGPT's encrypted Action authentication field. Never put it in the OpenAPI
  schema, GPT instructions, chat, source, logs, screenshots, or a worker
  service.

The contract defines exactly four operations:

- `runBackstageBooker` -> `POST /gpt/backstage-booker` for the public
  `generateBooking`, `generateBookingWithHRC`, and `simulateMatch` actions. A
  valid saved Action bearer can authorize optional configured Notion context
  for the two generation actions without making this public route fail closed.
- `getBackstageUniverse` ->
  `GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}`
  for one authenticated, non-consequential, read-only PostgreSQL snapshot.
- `getBackstageStoryline` ->
  `GET /gpt-access/capabilities/v1/backstage-booker/universes/{universeId}/storyline-summary`
  for the full summary of one exact durable canon storyline in fixed pages.
- `writeBackstageCanon` ->
  `POST /gpt-access/capabilities/v1/backstage-booker/run` for only
  `upsertStoryline` and `appendCanonBeat`.

Every `runBackstageBooker` request requires `executionMode: "sync"`. The fixed
value requests inline execution and avoids automatic heavy-prompt queueing;
the async result bridge is intentionally absent from this focused
contract. A synchronous request that exceeds the bounded route deadline
returns `504`.

`getBackstageUniverse` is marked `x-openai-isConsequential: false`. It accepts
only the dedicated Backstage bearer, never the generic GPT Access token, and
does not enter module dispatch, generation, confirmation, or persistence. It
uses an exact `universeId`; no list, display-name lookup, or registry is
exposed. Because the data model has no universe registry, an ID with no stored
rows returns `200` with `hasPersistedData: false`, not a claim that a named
universe does or does not exist. The snapshot is bounded and reports response
truncation explicitly. Each of its seven bounded data statements has a
3.5-second transaction-local PostgreSQL timeout; a failed snapshot returns a
retryable `503` and is never presented as an empty universe. Legacy payloads
are projected to bounded scalar fields in PostgreSQL before Node materializes
them. `sourceQueryLimits` are recent-data windows rather than total counts.

`getBackstageStoryline` is also non-consequential and uses the same
dedicated bearer, PostgreSQL-only read path, no-store policy, rate limit, body
rejection, and 3.5-second statement timeout. It performs one exact indexed
lookup by `universeId` plus `storylineKey`; it does not list storylines, enter
module dispatch, generate content, write canon, or use an in-memory fallback.
The key is a query parameter because valid canon keys can contain spaces,
slashes, punctuation, and Unicode. The service returns at most 4,000 Unicode
code points per page and preserves the stored summary exactly, including the
difference between `null` and an empty string. Page zero returns the storyline
version. Every nonzero `offset` must include that value as `expectedVersion`;
a `409 BACKSTAGE_STORYLINE_VERSION_CONFLICT` means the caller must discard the
collected pages and restart at offset zero.

`writeBackstageCanon` is marked `x-openai-isConsequential: true`, so ChatGPT
must display its Allow/Deny action banner before invoking it. The dedicated
backend boundary accepts the Backstage credential only at that exact path and
only for those two canon actions. It retains schema validation, the module
allowlist, rate limiting, a strict 256 KiB UTF-8 JSON transport limit, no-store
responses, version fencing, PostgreSQL transactions, and mutation-ID
idempotency, but it does not issue the ordinary backend confirmation challenge.
The fixed lane may bypass the generic
`ARCANOS_GPT_ACCESS_SCOPES` `capabilities.run` grant; it still requires the
exact `MCP_ALLOW_MODULE_ACTIONS` entries for both canon actions.

## Approval and security model

This lane intentionally treats ChatGPT's consequential-action banner as the
single human approval step. It avoids an expiring challenge and does not need a
longer `CONFIRMATION_CHALLENGE_TTL_MS` value. Ordinary challenges retain their
2-minute default.

The tradeoff is explicit: the backend authenticates possession of a shared
Action bearer token, but cannot independently prove that a particular person
saw or accepted ChatGPT's banner. The design therefore trusts the ChatGPT
Action platform to enforce the consequential flag before sending the request.
Anyone who obtains the bearer can read any valid exact universe ID, including
full summaries selected by an exact storyline key, and can
exercise the narrow canon endpoint without establishing per-user identity. If
Notion enrichment is configured, the same holder can also request generation
for any mapped universe and cause selected page excerpts to enter the model
prompt. The mapping is therefore an authorization boundary as well as routing
configuration.
This contract therefore assumes a private GPT within one trust domain. Do not
publish it or use it across tenant-separated universes without first adding
server-side credential-to-universe or per-user authorization. Keep the
credential purpose-bound, rotate it
after suspected exposure, and use a different authentication design if
per-user identity or an independently verified approval is required.

The credential is deliberately not interchangeable with
`ARCANOS_GPT_ACCESS_TOKEN` or `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN`. It cannot
call generic GPT Access operations, admit a direct Backstage request, authorize
a mutation on a direct Backstage route, or call control-plane, GPT-selected
`/dispatch`, `/modules/backstage-booker`, `/queryroute`, or legacy aliases. Its
only direct-route meaning is the optional request-local Notion-enrichment flag
on canonical synchronous Backstage generation. Conversely, the generic GPT
Access credential cannot read
stored Backstage universe content through this endpoint and continues to use
its scope, allowlist, and backend confirmation rules on a capability run.
All Phase One mutations (`bookEvent`, `updateRoster`, `trackStoryline`, and
`saveStoryline`) and every direct/control-plane/legacy mutation retain the
existing backend confirmation contract.

`universeId` only selects the durable data scope. It is not authentication,
authorization, tenant identity, or proof that the caller owns that universe.

## Optional Notion generation context

This feature is backend-only at the Action-contract level: it does not add a
fifth operation or change request/response schemas, so the existing GPT does
not need a schema re-import solely for Notion enrichment. Keep Apps disabled
and retain the existing Action API Key/Bearer setting. The backend accepts the
saved Backstage credential on `runBackstageBooker` only as optional provenance;
anonymous or invalid-bearer calls continue with the existing non-Notion
PostgreSQL/process-fallback behavior.

On the web service, configure both
`ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN` and
`ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON`. The first is an outbound Notion
integration token with read-content access only. Never place it in Builder.
The second maps each exact universe ID to one to three unique raw page UUIDs;
do not use page URLs. Share only those pages with the integration, and map
child pages explicitly because the reader never follows unknown child IDs.
Notion text is bounded, sanitized, and quoted in a separately delimited user
message before the primary booking request. A server-owned system policy tells
the model that this message has no instruction authority and that PostgreSQL
canon, roster, events, and continuity take precedence. This role/order boundary
reduces prompt-injection risk, but model adherence and semantic conflict or
excerpt-disclosure detection are not deterministic. Map only pages whose
contents are approved both for the existing OpenAI generation request and for
possible generated-answer disclosure. The enrichment can neither write Notion
nor persist Backstage data. When enrichment is used, the backend also redacts
lineage content, suppresses prompt-debug response content, and skips generic
module-session transcript writes. An enriched HRC review also bypasses the
shared result cache
and sanitizes provider-failure verdicts. Enriched generation and its sensitive
HRC follow-up force OpenAI Responses `store: false` even when global
`OPENAI_STORE` is enabled; non-content audit metadata and token counts remain.

After deployment, make one `generateBooking` call for a mapped test universe
and verify the web service emits the sanitized
`backstage.notion_context.loaded` event without inspecting raw prompt content.
Then make the same request without the dedicated bearer and verify no Notion
request/event occurs while generation still succeeds from PostgreSQL. OpenAI's
current Actions documentation says API-key authentication is configured in the
GPT editor and stored encrypted, but does not explicitly guarantee how a saved
key is applied to an operation whose OpenAPI `security` is omitted. If the
credential is not present on `runBackstageBooker`, enrichment must remain off;
do not weaken the backend gate. Treat an explicit reviewed Builder-contract
authentication change as a separate follow-up.

## Configure the existing GPT

Repository changes do not update the external Custom GPT automatically. After
the exact backend revision and contract route are deployed:

1. Create a distinct strong credential through the approved secret-management
   workflow. Set `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` only on the web
   service. Do not display or copy it into a shell command, chat, or document.
2. Open the existing Backstage Booker GPT in ChatGPT Builder and edit its
   existing Action. Import
   `https://acranos-production.up.railway.app/contracts/backstage_booker.openapi.v1.json`.
   Do not create a second ARCANOS Action schema.
3. Under Authentication, select **API Key** and **Bearer**, then enter the same
   dedicated credential in the authentication field.
4. Verify the imported operation IDs are exactly `runBackstageBooker`,
   `getBackstageUniverse`, `getBackstageStoryline`, and
   `writeBackstageCanon`. Both reads must be shown as non-consequential and the
   write as consequential. The schema must not contain `confirmation_token`.
5. Preserve the GPT's name, instructions, knowledge, conversation starters,
   model selection, visibility, and sharing settings except for the reviewed
   Action/instruction changes. Save the same GPT.
6. Reopen the saved GPT. Check one public generation/simulation request and one
   exact-ID snapshot read, one paged storyline-summary read, then perform a
   separately authorized canon write in an
   isolated test universe.
   Confirm the Allow/Deny banner appears before `writeBackstageCanon`, denial
   sends no mutation, allowance produces one response, and the response does
   not ask for a second confirmation token.

Use the following policy text in the GPT instructions without placing the
credential there:

```text
Use runBackstageBooker only for generateBooking, generateBookingWithHRC, and
simulateMatch.
Always keep executionMode set to "sync" for runBackstageBooker, as required by
the Action schema.

Use getBackstageUniverse when the user asks to retrieve or inspect already
stored Backstage state and provides an exact universeId. Preserve the ID
exactly. Never guess it from a display name, enumerate universe IDs, or use a
booking-generation or mutation action as a read substitute. Treat
hasPersistedData false as "no stored Backstage rows were observed," not as
proof that a separately named universe does not exist. If truncation.truncated
is true, disclose the listed sections and omitted counts.
Treat any collection equal to its sourceQueryLimits value as a bounded recent
window, not proof that no older records exist; omittedItems does not count rows
outside those source windows.

When snapshot.canon.storylines.summary is listed as truncated and the full
stored summary is needed, use getBackstageStoryline with the exact
universeId and storyline key. Start with offset 0. If hasMore is true, call it
again with nextOffset and the exact storyline.version returned by page zero as
expectedVersion. Continue until hasMore is false, then concatenate text in
offset order without trimming, rewriting, or inserting separators. Keep null
distinct from an empty string. If the backend returns
BACKSTAGE_STORYLINE_VERSION_CONFLICT, discard every collected page, report that
canon changed during the read, and restart at offset 0 only if the user still
wants the current version. Never use generation or a mutation as a read
substitute, and never claim that a bounded universe preview is the full stored
summary.

Use writeBackstageCanon only when the user explicitly asks to create or change
durable canon through upsertStoryline or appendCanonBeat. Preserve the user's
exact universeId and treat it only as data scope, never as authorization.

Before a canon call, construct and explain the exact proposed mutation. Let
ChatGPT's consequential Action banner collect the user's Allow or Deny choice.
Do not claim that discussion in chat is approval, do not ask the user to paste
a password or API key, and do not put credentials in any action payload.

Every new semantic canon mutation needs a new UUID mutationId. Reuse the same
mutationId only to retry the identical normalized request. Preserve
expectedVersion exactly; never silently change it to avoid a version conflict.
If the backend returns BACKSTAGE_STORYLINE_NOT_FOUND, stop and report the
missing storyline. Do not silently change expectedVersion to 0 or create a
replacement storyline; creation is a distinct consequential mutation.

The dedicated writeBackstageCanon operation does not use confirmation_token.
If it returns CONFIRMATION_REQUIRED, stop and report an Action/backend
configuration mismatch. Do not switch to a generic GPT Access, direct,
control-plane, dispatch, module, queryroute, or legacy alias to bypass it.

Do not use writeBackstageCanon for bookEvent, updateRoster, trackStoryline, or
saveStoryline. Those Phase One mutations remain outside this Action contract
and retain the backend's separate confirmation flow.
```

## Rotation, revocation, and rollback

There is no previous-token overlap variable for this lane. Plan rotation as a
brief maintenance window:

1. Generate a new distinct credential through the approved secret workflow.
2. Update the exact web-service variable and deploy it, then immediately update
   the existing GPT's API Key/Bearer authentication and save. Requests can
   return authentication errors between the two updates; do not weaken the
   boundary to hide that gap.
3. Reopen the saved GPT and repeat the consequential-banner check. Verify that
   the old credential no longer works without printing either value.

To revoke the lane, delete `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` from the web
service through an approved deployment change and remove or disable the
protected Action configuration. Missing dedicated authentication fails closed;
do not substitute the generic GPT Access or control-plane credential.

For feature rollback, restore the last reviewed Builder schema,
authentication, and instruction configuration, revoke the dedicated web
credential, and deploy the approved backend revision. Rollback of the endpoint
does not erase canon already committed. Any data correction is a separate,
explicitly reviewed canon operation.
