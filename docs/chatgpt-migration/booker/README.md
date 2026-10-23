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

## Connection and acceptance gates

No plugin manifest with a guessed endpoint, package upload, account installation,
OAuth registration or deployment is part of this slice. To connect later:

1. Review and merge only with owner authorization. Approve the exact deployment
   and rollback separately; retain the existing Custom GPT during acceptance.
2. Provision an independent private OAuth client/API with PKCE S256 and issuer
   discovery. Bind the actual resource into token audience, the actual client
   into signed `client_id` or `azp`, and grant Booker scopes independently.
   Configure the exact owner/universe pair and existing protected web/worker
   prerequisites through the approved operational path. Never copy the Builder
   bearer or credentials into a plugin.
3. Verify the deployed metadata and seven-tool catalog at the approved HTTPS
   endpoint, signed-token rejection/acceptance and owner/universe isolation.
4. Reconcile the private GPT instruction/knowledge inventory; version the source
   skill and create one private package with the verified endpoint in `mcp.json`.
   Use the actual OAuth connection settings and account-provided redirect URI.
   Do not create duplicate plugins on retries.
5. Run authorized fresh/stale/invalid-cursor continuity, protected booking, HRC,
   simulation, idempotency and same-job continuation acceptance. Capture actual
   provider, Notion, database, ChatGPT web and iOS evidence separately from
   mocked tests, CI and sealed preview results.

OAuth setup follows [official OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth).
An HTTPS URL or uploaded ZIP alone proves none of these gates.

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
