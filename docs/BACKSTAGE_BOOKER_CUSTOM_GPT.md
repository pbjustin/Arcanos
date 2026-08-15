# Backstage Booker Custom GPT

This is the Builder-facing configuration for the existing **Backstage Booker**
Custom GPT. It adds a narrow canon-writing lane with one visible ChatGPT
consequential-action approval instead of a second, time-limited backend
confirmation challenge.

## Action configuration

- Import schema: `https://acranos-production.up.railway.app/contracts/backstage_booker.openapi.v1.json`
- Repository contract: [`contracts/backstage_booker.openapi.v1.json`](../contracts/backstage_booker.openapi.v1.json)
- Schema version: `1.0.0`
- Canonical server: `https://acranos-production.up.railway.app`
- Authentication: in ChatGPT Builder select **API Key**, then **Bearer**. Enter
  only the dedicated `ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` value. This is a
  static purpose-bound Action credential, not OAuth and not a user's password.
- Secret placement: store the value only in the Railway web service and
  ChatGPT's encrypted Action authentication field. Never put it in the OpenAPI
  schema, GPT instructions, chat, source, logs, screenshots, or a worker
  service.

The contract defines exactly two operations:

- `runBackstageBooker` -> `POST /gpt/backstage-booker` for the public
  `generateBooking`, `generateBookingWithHRC`, and `simulateMatch` actions.
- `writeBackstageCanon` ->
  `POST /gpt-access/capabilities/v1/backstage-booker/run` for only
  `upsertStoryline` and `appendCanonBeat`.

Every `runBackstageBooker` request requires `executionMode: "sync"`. The fixed
value requests inline execution and avoids automatic heavy-prompt queueing;
the async result bridge is intentionally absent from this two-operation
contract. A synchronous request that exceeds the bounded route deadline
returns `504`.

`writeBackstageCanon` is marked `x-openai-isConsequential: true`, so ChatGPT
must display its Allow/Deny action banner before invoking it. The dedicated
backend boundary accepts the Backstage credential only at that exact path and
only for those two canon actions. It retains schema validation, the module
allowlist, rate limiting, no-store responses, version fencing, PostgreSQL
transactions, and mutation-ID idempotency, but it does not issue the ordinary
backend confirmation challenge. The fixed lane may bypass the generic
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
Anyone who obtains the bearer can exercise this narrow endpoint without
establishing per-user identity. Keep the credential purpose-bound, rotate it
after suspected exposure, and use a different authentication design if
per-user identity or an independently verified approval is required.

The credential is deliberately not interchangeable with
`ARCANOS_GPT_ACCESS_TOKEN` or `ARCANOS_CONTROL_PLANE_ACCESS_TOKEN`. It cannot
call generic GPT Access operations, direct Backstage routes, control-plane
routes, GPT-selected `/dispatch`, `/modules/backstage-booker`, `/queryroute`,
or legacy aliases. Conversely, the generic GPT Access credential continues to
use its scope, allowlist, and backend confirmation rules on a capability run.
All Phase One mutations (`bookEvent`, `updateRoster`, `trackStoryline`, and
`saveStoryline`) and every direct/control-plane/legacy mutation retain the
existing backend confirmation contract.

`universeId` only selects the durable data scope. It is not authentication,
authorization, tenant identity, or proof that the caller owns that universe.

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
4. Verify the imported operation IDs are exactly `runBackstageBooker` and
   `writeBackstageCanon`; the latter must be shown as consequential. The schema
   must not contain `confirmation_token`.
5. Preserve the GPT's name, instructions, knowledge, conversation starters,
   model selection, visibility, and sharing settings except for the reviewed
   Action/instruction changes. Save the same GPT.
6. Reopen the saved GPT. Check one public generation/simulation request, then
   perform a separately authorized canon write in an isolated test universe.
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
