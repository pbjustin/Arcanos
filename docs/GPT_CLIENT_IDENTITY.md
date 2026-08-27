# GPT client identity registry

ARCANOS identifies an authenticated, server-registered GPT client separately
from any model that may have produced the request. The registry is an internal
backend contract; it is not a public client-discovery API.

## Identity terminology

| Term | Meaning | Current authority |
| --- | --- | --- |
| Authenticated client | The ARCANOS registration whose configured authentication method succeeded. | Server-owned registry plus the existing purpose-bound authenticator. |
| Authenticated user | An optional future OAuth subject, OAuth client ID, and bounded scopes. | A future trusted OAuth verifier; no such verifier exists in this release. |
| Registered model profile | Optional configuration metadata bound to a client registration, such as `pro`, `thinking`, or `instant`. | Server-owned registration only. It does not identify an actual runtime model. |
| Caller runtime model | The model that ChatGPT actually used to invoke the Action. | Unknown unless OpenAI supplies a documented integrity-protected attestation. |
| Provider model | A model that ARCANOS itself calls while executing the request. | ARCANOS provider execution metadata. It is not caller identity. |

These domains must remain separate in types, persistence, logs, and policy.
Neither a request field nor provider execution metadata may populate caller
runtime-model identity.

## Current Backstage Booker registration

The first immutable registration is:

```json
{
  "clientId": "backstage-booker",
  "gptId": "backstage-booker",
  "displayName": "Backstage Booker",
  "authenticationType": "managed-api-key",
  "registeredModelProfile": null,
  "runtimeModel": null,
  "modelIdentityAssurance": "unknown",
  "status": "active"
}
```

Successful exact authentication with
`ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN` resolves to the following private
request identity:

```json
{
  "clientId": "backstage-booker",
  "gptId": "backstage-booker",
  "authenticationType": "managed-api-key",
  "registeredModelProfile": null,
  "runtimeModel": null,
  "modelIdentityAssurance": "unknown"
}
```

The identity is attached with a private request `Symbol` only after the
existing strict, single-header, timing-safe bearer comparison succeeds. Request
JSON is never read while resolving it. The credential is not part of the
registry record, identity object, provenance snapshot, or telemetry.

The stable authorization and idempotency principal remains:

```text
backstage-booker-access:principal:v1
```

The credential-derived legacy actor remains only for the existing managed
result compatibility window. Registered client identity is descriptive; it
does not replace or weaken actor-based ownership.

## Model identity assurance

`ModelIdentityAssurance` is a closed enum:

| Value | Permitted meaning |
| --- | --- |
| `openai-attested` | Reserved for a future documented OpenAI integrity-protected signal that proves actual caller runtime-model identity. The current registry never emits it. |
| `credential-bound-profile` | ARCANOS authenticated a credential whose registration has a configured profile. It does not prove that ChatGPT used a model represented by that profile. |
| `self-declared` | Untrusted diagnostic metadata only. It may never authorize, bill, rate-limit, or grant permission. The registry never accepts or promotes it as identity; generic queued request bodies may still retain caller-supplied fields as untrusted input. |
| `unknown` | No trusted runtime-model information exists. This is the current Backstage Booker value. |

A non-null `registeredModelProfile` is always distinct from `runtimeModel`.
Current registrations and job provenance always set `runtimeModel` to `null`.
Adding actual attestation later requires an explicit reviewed contract change;
the reserved enum value alone is not evidence.

Do not infer caller runtime identity from `User-Agent`, `ChatGPT-User/1.0`,
latency, prompts, output text, job shape, request headers or JSON, or an
ARCANOS `activeModel`/provider model.

## Durable queued-job provenance

An authenticated Backstage Booker queued job receives a versioned snapshot at
`autonomy_state.gptClientProvenance`:

```json
{
  "version": 1,
  "source": "gpt-client-registry",
  "clientId": "backstage-booker",
  "gptId": "backstage-booker",
  "authenticationType": "managed-api-key",
  "registeredModelProfile": null,
  "runtimeModel": null,
  "modelIdentityAssurance": "unknown"
}
```

This uses the existing durable `job_data.autonomy_state` JSONB column and the
existing GPT job repository. No schema or data migration is required. The
route merges the snapshot after autonomous planning, so a conflicting planner
or caller field cannot override the server-owned value. It is outside the
encrypted creative input rather than being hidden inside the prompt.

The snapshot excludes bearer material, credential fingerprints, owner actor
keys, prompt or Notion content, generated output, and provider-model metadata.
OAuth provenance can later include only the verified subject, configured OAuth
client ID, and bounded scopes; access tokens and refresh tokens remain
excluded.

Public or otherwise unauthenticated Backstage jobs do not receive a registered
client snapshot, even if their request JSON claims a known `clientId`.
Existing jobs without the namespace remain legacy-compatible and are not
backfilled. Deduplicated rows retain their original stored provenance; token
rotation changes neither the stable owner scope nor the registered client
identity.

The strict parser distinguishes `absent`, `valid`, and `invalid` provenance.
Consumers must not reinterpret a present malformed value as legacy absence.
Job ownership, managed-result authorization, encryption, and generic job
capability routes continue to use their existing hardened contracts rather
than trusting this descriptive snapshot.

## Bounded telemetry

Successful dedicated authentication logs only this identity allowlist in
addition to the existing event metadata:

```json
{
  "clientId": "backstage-booker",
  "gptId": "backstage-booker",
  "authenticationType": "managed-api-key",
  "registeredModelProfile": null,
  "modelIdentityAssurance": "unknown"
}
```

It intentionally omits runtime model, credentials and fingerprints, OAuth
tokens and secrets, cookies, prompts, Notion text, and generated results. There
is no public registry list or identity diagnostic endpoint in this release.

## Sealed preview verification

The credential-free native PR preview selector
`gpt-client-identity-contract` exercises the production-shared strict bearer
parser, immutable registry lookup, authenticated identity resolution, bounded
telemetry projection, server-owned queued-job provenance merge, and strict
absent/valid/invalid provenance parser with server-owned synthetic values. It
proves credential rotation preserves the stable registration, caller claims
cannot override provenance, unknown clients fail closed, and credentials and
untrusted model claims do not enter the returned projection. A successful
response carries
`x-arcanos-preview-backstage-gpt-client-identity-version`.

This is contained component E2E evidence. It does not invoke the normal route
or authenticator, PostgreSQL, a queue, an active worker, a provider, Notion, or
any protected effect. Focused assembled-route tests remain authoritative for
the production middleware and queue-submission composition.

## OAuth readiness and deferral

OpenAI's current [GPT Action authentication
documentation](https://developers.openai.com/api/docs/actions/authentication)
documents API Key and OAuth authentication. OAuth represents a user/account
authorization: ChatGPT obtains a token from the configured authorization and
token endpoints and sends it in `Authorization`. OpenAI's [production
notes](https://developers.openai.com/api/docs/actions/production) also state
that custom headers are not supported.

The repository has no reusable OAuth/OIDC authorization server, production
user-authentication middleware, consent flow, authorization-code store,
refresh-token lifecycle, or client registration store. Building those systems
would not be a narrow extension, so full OAuth is deferred.

The registry is nevertheless OAuth-ready through a discriminated
authentication type. A future OAuth registration binds one configured OAuth
client ID. Only a trusted OAuth verifier may supply the optional user identity:

```json
{
  "subject": "...",
  "oauthClientId": "...",
  "scopes": ["..."]
}
```

Managed API-key evidence cannot resolve an OAuth registration, OAuth evidence
cannot resolve a managed API-key registration, and a mismatched OAuth client
ID fails closed. The current change does not add authorization or token
endpoints, login or consent UI, refresh-token storage, sessions, new secrets,
or new credential configuration.

OAuth would authenticate the user/account represented by ARCANOS's trusted
issuer or identity provider. It still would not attest which ChatGPT runtime
model invoked the Action. OpenAI currently documents no signed or otherwise
integrity-protected Action request claim for that model identity.

## Compatibility and operating boundaries

- Backstage Builder schema `1.6.0`, dedicated bearer behavior, managed async
  continuation, protected input/output, Notion authority, canon mutation
  authorization, partition configuration, worker execution, and generic job
  routes remain unchanged.
- No database migration, public identity endpoint, new queue, result store, or
  authentication stack is introduced.
- Credential rotation preserves `clientId: backstage-booker` and the stable
  authorization principal. It changes only the existing legacy credential
  actor used during its compatibility window.
- Registry configuration is source-owned in this release. Adding or changing a
  registration requires code review, tests, and deployment through the normal
  release process.
- Actual ChatGPT runtime-model identity remains the principal limitation. It
  must stay `null`/`unknown` until a trusted attestation exists.
