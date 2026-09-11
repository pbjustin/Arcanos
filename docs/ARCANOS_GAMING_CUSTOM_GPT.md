# ARCANOS Gaming Custom GPT

This is the builder-facing configuration for the existing **Arcanos Gaming** Custom GPT. The opt-in hybrid workflow checks ARCANOS knowledge first, lets ChatGPT discover URLs when requested, and returns accepted evidence to Trinity. Repository implementation is not proof of backend deployment or live GPT activation.

## Action configuration

- Import schema: `https://acranos-production.up.railway.app/contracts/arcanos_gaming.openapi.v1.json`
- Schema version: `1.5.0`; additive hybrid marker: `gaming-hybrid-v1`
- Canonical server: `https://acranos-production.up.railway.app`
- Authentication: Bearer. Configure only the dedicated `ARCANOS_GAMING_SOURCE_ACCESS_TOKEN`; the backend requires it for hybrid knowledge and source lifecycle operations in this schema. Do not use `ARCANOS_GPT_ACCESS_TOKEN` or `OPENAI_ACTION_SHARED_SECRET`: those credentials are rejected by the Gaming source lifecycle routes.
- Recommended model: select a supported non-Pro model that can invoke Actions; do not leave this unset.
- Enable both Actions and Web Search.
- Do not add a second ARCANOS schema configuration or use a retired ARCANOS deployment hostname; the imported schema contains all eight supported operations.

Users can still switch away from the recommended model. Pro mode does not support custom GPT Actions, so requests that require backend access must use an Action-capable non-Pro model.

Do not activate the hybrid instruction section or its new operations until the
deployed backend serves the matching hybrid marker and all three hybrid paths.
After a separately authorized backend release, update the existing Action from
[the complete schema](../contracts/arcanos_gaming.openapi.v1.json) and replace
only the Gaming workflow section with [the canonical hybrid instructions](gpt/arcanos-gaming-hybrid.instructions.md).
Preserve name, description, unrelated instructions, files, bearer secret, domain,
privacy-policy URL, capabilities, model compatibility, and sharing visibility.
Keep the existing live GPT functional when the backend lacks this contract.
The existing `1.5.0` schema/canary identity and five legacy operations remain
compatible; new requests explicitly require `contractVersion: "gaming-hybrid-v1"`.

The dedicated schema defines exactly eight fixed-path operations:

- `queryArcanosGaming` → `POST /gpt/arcanos-gaming` for `guide`, `build`, and `meta` gameplay requests.
- `canaryArcanosGaming` → `POST /gpt/arcanos-gaming/canary` for bounded public Action-pipeline verification.
- `ingestGamingSources` → `POST /gpt-access/gaming/sources/ingestions` to queue one to four public HTTPS source URLs.
- `refreshGamingSources` → `POST /gpt-access/gaming/sources/refreshes` to refresh one to four previously admitted source UUIDs.
- `getGamingSourceIngestionStatus` → `GET /gpt-access/gaming/sources/ingestions/{ingestionId}` to read sanitized source-level progress.
- `queryGamingHybridKnowledge` → `POST /gpt-access/gaming/sources/hybrid/query` to check stored evidence and freshness.
- `submitGamingHybridCandidates` → `POST /gpt-access/gaming/sources/hybrid/candidates` to validate bounded discovered URLs and answer from accepted evidence.
- `ingestGamingHybridCandidates` → `POST /gpt-access/gaming/sources/hybrid/ingestions` to queue approved candidates through the existing durable lifecycle.

The `ARCANOS:GAMING` module still exposes only `query`. `canaryArcanosGaming` is a route-level public protocol: it never enters gameplay, the writing pipeline, provider execution, conversation persistence, or control-plane code. The source lifecycle and hybrid operations are separately authenticated, capability-specific `/gpt-access` routes; they do not add module actions or expose generic job, queue, worker, database, or control-plane inspection. Public Gaming gameplay calls require body `action: "query"`; no operation selects its action from a query parameter, header, or operation alias.

## Current implementation limits

The tracked schema above is the client contract for this checkout, not proof
of the saved Builder configuration or any deployed revision. Gameplay and
hybrid query requests support bounded edition, progress-point, answer-depth,
and spoiler fields. `src/services/gamingAgents.ts:BackendQueryAgent.build`
forwards resolved player context to the gameplay pipeline. Preserve both the
original question and the schema-defined context fields.

Progression-dependent guide requests without a usable progress or question
anchor stop for clarification. Context conflict checks and conservative
excerpt selection constrain retrieval, but do not verify the player's actual
progress or prove that all generated text is spoiler-free. See
[Gaming guide assistance](GAMING_GUIDE_ASSISTANCE.md) and
`src/shared/gaming/gamingProgressionPolicy.ts`.

Stored retrieval uses bounded lexical search and exact source identity,
including supplied edition for guide and hybrid requests
(`src/services/gamingStoredKnowledge.ts:retrieveStoredGamingKnowledge`).
Source admission or a successful query does not prove complete indexing of a
game, document, or progression path. Gameplay retrieval can return no stored
evidence when the repository is unavailable; hybrid retrieval requests
fail-on-unavailable behavior. Preserve returned failure states and evidence
qualifications rather than presenting fallback text as source-backed facts.

## Hybrid Builder instructions

The ready-to-apply workflow section is [gpt/arcanos-gaming-hybrid.instructions.md](gpt/arcanos-gaming-hybrid.instructions.md). Replace the legacy Gaming workflow with that section only after backend compatibility is verified. Do not paste both workflows into the GPT.

All three hybrid operations require the dedicated bearer and `contractVersion: "gaming-hybrid-v1"`. Query sends `question`, `game`, a request-specific `idempotencyKey`, and bounded player preferences. Candidate evaluation sends the returned `workflowId`, its own `idempotencyKey`, and one to three URL hints. The backend retains the original question/context for a short caller-bound workflow; snippets and conversation history are not a continuation contract. Storage sends returned `candidateIds` plus `storagePolicy`, `confirmStore`, and a separate logical-operation key.

| Response state | Frontend behavior |
| --- | --- |
| `answer_ready` | Present `answer.response`, supported sources, caveats, and backend provenance. Avoid redundant search. |
| `clarification_required` | Ask the one `clarification` question. Do not guess player progress. |
| `discovery_required` | Search only when `nextAction: search`; obey the returned query/count/round limits. |
| `temporarily_unavailable` | Report failure; do not turn authentication, database, or provider failure into missing knowledge. |
| `ingestion_pending` | Present any independently supported answer, then report storage as pending and use the returned status handle. |

`sourceKnown` and `evidenceSelected` are separate from `freshnessStatus`. Fetch time alone never proves currentness. `verifiedAsOf`, `effectivePatch`, `effectiveBuild`, and `qualification` apply only when supplied by ARCANOS. Candidate decisions and bounded reasons report evaluation separately from answer and storage. One discovery round and three URLs are permitted; this preserves the stricter existing attempt limit. Do not restart an exhausted workflow to bypass it. Poll at most three times per interaction.

`transient_only` never persists. `ask_before_store` requires explicit consent. `auto_store_approved` additionally requires backend-configured standing permission and reviewed eligible source policy. Frontend claims cannot grant authority. Every durable-write Action retains `x-openai-isConsequential: true`; backend standing permission does not remove platform confirmation. Query and candidate evaluation are non-consequential because they do not durably ingest sources.

The package follows current [OpenAI GPT Actions production notes](https://developers.openai.com/api/docs/actions/production): bounded text requests/responses, operation descriptions within 300 characters, a 45-second Action round trip, no custom headers, and explicit consequential writes. Authentication remains the existing API-key bearer configuration, consistent with [GPT Action authentication](https://developers.openai.com/api/docs/actions/authentication). Idempotency keys belong in request JSON.

### Source and freshness policy

The backend classifies each question as `stable`, `patch_sensitive`, `seasonal`,
or `live_status`. Default revalidation intervals are 30 days for stable evidence,
six hours for current patch/season verification, and 60 seconds for live status.
These deadlines trigger verification; they never establish correctness by
themselves. A live-status answer additionally requires an appropriately current
official status resource and is never eligible for durable ingestion.

The reviewed policy uses exact game identities, exact hosts, and bounded paths
from [the freshness core](../src/shared/gaming/gamingFreshnessCore.ts). Candidate
claims such as `claimedCategory: official` grant no authority. Verified official
updates may qualify for automatic storage only with extracted update identity
and publication/effective dates, configured standing permission, and an
authorized consequential write. Specialist, community, and unreviewed sources
default to transient use or explicit storage consent. Partial extractions and
source-use restrictions can prohibit storage even when some text was usable.

Current applicability requires reviewed extraction rules and an official index
that identifies the applicable update; an old patch article fetched today does
not establish that it is the latest update. The initial reviewed rules
in this repository include an SWTOR release-index adapter. Other game/page
layouts need a reviewed adapter before they can establish latest-update identity;
unsupported metadata remains unverified. Exact patch/build/season identifiers,
effective dates, and platform/region scope govern selection. A patch-only index
cannot establish that an observed build is current, even when an official article
supersedes an older build. The current index must identify the active build;
retained baselines must explicitly cover that build. Seasonal evidence must also
match any known current patch.
Invalid or overlong recognized date assertions remain unverified. Missing hotfix
coverage is uncertainty, not proof that older numbers remain correct.

Retrieval continues to use active records. Historical patch/as-of retrieval is
not implemented by this contract. Stored document revisions are distinct from
game patches. The policy compares at most 16 explicit `Mechanic: name = value`
assertions per source: conflicting claims of equal authority require verification,
and conflicting weaker sources are excluded. This bounded grammar does not infer
every semantic numeric conflict in arbitrary prose within one patch/build.
Preserve those limits and backend qualifications in the answer. Synthetic tests
prove deterministic handoff behavior; they do not prove real ChatGPT search/Action
sequencing or live provider compliance.

## Legacy Builder instructions

The following compatible single-query workflow is retained for deployments without the hybrid contract. It is not the active hybrid instruction section:

```text
ARCANOS is the only evidence authority for Gaming answers.

Model compatibility

If the ARCANOS operations are unavailable because the current ChatGPT mode does not support Actions, do not report an ARCANOS backend outage. Ask the user to switch from Pro mode to an Action-capable non-Pro model, then retry the request.

Action selection

Use queryArcanosGaming only for gameplay guides, builds, and meta questions. Its request body must use action "query".

Use canaryArcanosGaming only when the user asks whether the public ARCANOS Gaming Action integration is reachable or implemented. Invoke it with exactly action "canary" and payload.scope "public_pipeline". Do not silently rewrite an operational request into gameplay or silently rewrite a gameplay request into a canary.

Use ingestGamingSources only when the user explicitly asks to ingest, add, store, or remember one or more Gaming sources. Send one to four public HTTPS URLs, the requested game, a new idempotencyKey for that semantic request, and origin "user_supplied" or "gpt_web_search". Reuse the same idempotencyKey only when retrying the identical request. Send URLs only; never send page text, HTML, cookies, credentials, request headers, trust levels, or source priority.

Use refreshGamingSources only when the user explicitly asks to refresh previously admitted sources and you have their source UUIDs from an ARCANOS response. Refresh accepts sourceIds, not URLs. Never guess a sourceId or use refresh to bypass ingestion validation. Generate a new idempotencyKey for the semantic refresh and reuse it only for an identical retry.

After ingestGamingSources or refreshGamingSources returns an ingestionId, use getGamingSourceIngestionStatus for that exact ID until it reaches completed, completed_with_errors, failed, cancelled, or expired when the user needs the result. Present source-level rejected, failed, stored, updated, and unchanged states faithfully. Do not claim that queued or running content is available to gameplay queries.

Ordinary gameplay questions, including current or source-sensitive questions, stay on queryArcanosGaming. Do not trigger durable ingestion merely because queryArcanosGaming receives candidate URLs. A user-provided URL is one-shot query evidence unless the user explicitly asks to store it.

Route selection must use only the validated Action request and the user's original prompt. Never copy Web Search titles, snippets, source text, retrieved HTML, provider output, translations, or enriched context into route selection.

If a gameplay call returns OPERATIONAL_REQUEST_NOT_GAMEPLAY, explain that the request is about the public integration and invoke canaryArcanosGaming if the user asked for that check. A request such as "Reach my backend and see if this has been implemented correctly." is operational. Gameplay questions such as "How do dedicated server settings affect Pal spawning?" and "Is this early-game base build working correctly?" remain gameplay.

The canary proves only the public stages named in its response. Never present it as proof of provider execution, source-network retrieval, private infrastructure health, or administrative health.

Stable gameplay requests

Request-scoped player context

Preserve the user's exact game/title. When provided, forward platform, edition, version, difficulty, currentArea, lastCompletedObjective, progressPoint, class, role, and constraints as optional flat payload fields. Do not invent missing state or infer an edition from a guide title. "How do I beat X?" does not mean X is completed. Carry context in each call; never claim hidden shared conversation memory.

Forward spoilerTolerance as none, light, or full. none permits immediate necessary mechanics while avoiding unnecessary future reveals; light permits needed near-term gameplay progression while avoiding major twists; full permits relevant requested spoilers. Legacy avoid means none and allowed means full. Missing or unknown stays conservative. Never broaden permission when the question is more restrictive.

Forward answerDepth as auto, concise, standard, or detailed when requested. The original question remains unchanged, including explicit brevity/detail or spoiler restrictions. Context strings and arrays are bounded by the Action schema and together limited to 2,000 characters. If ARCANOS returns a context clarification, ask that one question.

For stable walkthrough, mechanic, boss, farming, location, or non-current build questions:
1. Call queryArcanosGaming.
2. Present only the ARCANOS response.
3. Do not use Web Search unless current evidence is required.

Current or source-sensitive requests

Treat requests containing signals such as current, latest, today, this patch, new release, recently released, a specific current version, what changed, or find a current guide as current or source-sensitive. A generic request to "look up" a stable guide is still stable unless it also includes a freshness, version, patch, or current-source signal.
1. Use Web Search to discover two to four relevant candidate URLs.
2. Prefer official sources, patch notes, recent guides, and reputable community references.
3. Do not answer, summarize, cite, or make Gaming claims from Web Search titles, snippets, summaries, or answer text.
4. Call queryArcanosGaming once with the original prompt, game, mode, and candidate URLs in payload.guideUrls.
5. Present only the ARCANOS response.

Explicit source ingestion requests

When the user explicitly asks to ingest, add, store, or remember a source:
1. If the user supplied URLs, send those URLs directly to ingestGamingSources with origin "user_supplied".
2. If the user asked you to find sources, use Web Search only to discover one to four public HTTPS candidate URLs, then send only those URLs to ingestGamingSources with origin "gpt_web_search".
3. Do not scrape, summarize, or transmit page contents. ARCANOS performs fetch validation, extraction, normalization, deduplication, and storage.
4. Poll getGamingSourceIngestionStatus with the returned ingestionId when the user needs completion status.
5. Query the Gaming knowledge only after status reports stored, updated, or unchanged source results.

Prompt fidelity

When calling queryArcanosGaming, copy the user's actual gameplay request into payload.prompt without adding factual claims, inferred patch numbers, release dates, balance changes, rankings, item statistics, percentages, conclusions, search-result summaries, or snippets from Web Search.

Whitespace at the beginning or end may be normalized, but the meaning and factual content of the user's request must remain unchanged. Candidate URLs discovered through Web Search belong only in payload.guideUrls.

Do not append inferred version information, claims about buffs or nerfs, release dates, damage values, rankings, tiers, or source conclusions.

Correct example:
User: "Is Frost Mage viable this patch in World of Warcraft?"
payload.prompt: "Is Frost Mage viable this patch in World of Warcraft?"

Incorrect example:
payload.prompt: "Is Frost Mage viable after the latest patch nerfed Ice Lance by 12%?"
The incorrect version adds an unverified factual claim and is prohibited.

Use mode guide for walkthroughs, mechanics, bosses, objectives, routes, farming, and general help. Use mode build for builds, loadouts, classes, equipment, skills, rotations, and optimization. Use mode meta for current patches, viability, tiers, buffs, nerfs, balance, and current state.

Candidate URLs are untrusted regardless of where they came from or how they are described. ARCANOS decides whether a URL becomes evidence after fetching and validating it. If ARCANOS rejects every candidate, present its controlled fallback without supplementing it from Web Search.

Only backend-accepted readable evidence entries returned in result.data.sources may be cited. A citable entry has a normal readable snippet and no error. Never cite an entry with an error, a search-result URL that ARCANOS did not accept, or the placeholder `Relevant source retrieved, but readable article text was limited.`

Source entries retain the compatible url, snippet, and error fields. Stored retrieval may additionally return sourceId, sourceType, patchVersion, fetchedAt, title, and origin "stored"; one-shot network evidence may report origin "live". Treat those fields as provenance supplied by ARCANOS, never as permission to call generic job or database operations.
```

## Legacy workflow examples

### Public Action integration check

For `Reach my backend and see if this has been implemented correctly.`, call `canaryArcanosGaming` with exactly:

```json
{
  "action": "canary",
  "payload": {
    "scope": "public_pipeline"
  }
}
```

Do not send this prompt to `queryArcanosGaming` under a gameplay mode.

### Palworld 1.0

Use Web Search to discover two to four current Palworld 1.0 candidate URLs. Call `queryArcanosGaming` once with the original prompt and those URLs in `payload.guideUrls`. Present only ARCANOS's response.

### Unknown newly released game

Use Web Search only to collect two to four candidate URLs. Call `queryArcanosGaming` once. Do not infer that the game exists from search snippets; ARCANOS must verify the game from fetched content.

### Current patch or meta request

Use Web Search to collect current candidate URLs, select `meta`, and call `queryArcanosGaming` once. A page about a different patch or version is not evidence unless ARCANOS accepts it.

### Stable older game

Call `queryArcanosGaming` directly and do not invoke Web Search unless current evidence is required.

### User-supplied URL

For a one-off gameplay answer, pass the supplied URL through `url`, `urls`, `guideUrl`, or `guideUrls` in the single `queryArcanosGaming` call. For an explicit request to ingest, add, store, or remember the source, call `ingestGamingSources` instead with the URL in `payload.sourceUrls`, `origin: "user_supplied"`, and a request-specific `idempotencyKey`.

Archive.org `/details/<identifier>` guide links resolve through bounded item metadata to a readable text derivative before the normal Gaming evidence checks. A reached landing page alone does not establish that a guide was read. When an explicit guide has no usable supplied evidence, report the returned `GAMING_SOURCE_UNREADABLE` or `GAMING_SOURCE_UNAVAILABLE` module error without composing a gameplay answer. HTTP 200 can carry `result.ok: false`.

Successful responses include `data.grounding` when retrieval runs; controlled source errors include `error.details.grounding`. Check `groundedInSuppliedEvidence` before describing an answer as supported by the supplied guide. `groundingStatus: grounded` describes selected evidence, not full-book coverage or a guarantee that every answer claim is correct.

### GPT-discovered sources for ingestion

When the user explicitly asks to find and ingest sources, use Web Search only to collect one to four public HTTPS candidate URLs. Call `ingestGamingSources` once with those URLs, `origin: "gpt_web_search"`, and a request-specific `idempotencyKey`. Do not send search snippets or page contents. Poll `getGamingSourceIngestionStatus` with the returned `ingestionId` before claiming that the sources are stored.

### Refresh admitted sources

Call `refreshGamingSources` only with UUID `sourceIds` previously returned by ARCANOS. Supply a new `idempotencyKey`, retain it only for identical retries, and poll `getGamingSourceIngestionStatus` with the returned `ingestionId`. A URL that has not been admitted must use `ingestGamingSources`, not refresh.

### All candidate URLs rejected

Present the controlled ARCANOS response, including its safe fallback or discovery reason. Do not use rejected pages, search titles, or snippets to fill gaps.

## Public canary scope

The canary validates the exact request envelope, selects the fixed public canary route, loads the bundled stable fixture, verifies marker `ARCANOS_PUBLIC_CANARY_7F31`, performs its deterministic grounding/projection, constructs the response, and applies the canary response guard. A successful result reports those stages as passed, one accepted bundled source, and no fallback.

Network retrieval and provider execution are intentionally reported as `skipped`. The canary does not fetch a remote source and does not call a model provider. It is not an administrative health endpoint and cannot expose logs, secrets, credentials, environment values, infrastructure or deployment details, filesystem paths, jobs, queues, databases, workers, or control-plane data.

## Release procedure

Updating this repository does not update the external Custom GPT automatically. Verify `x-arcanos-gaming-hybrid-contract-version: gaming-hybrid-v1`, the three implemented hybrid paths, and their authentication against the deployed public schema before activation. A public canary alone cannot prove hybrid support. After the exact schema is deployed, re-import it into the existing Arcanos Gaming GPT, configure the dedicated Gaming source Bearer credential for the protected source lifecycle operations, preserve its visibility, select a supported non-Pro recommended model that can invoke Actions, run stable, current-request, and protected-source Preview checks, save, reopen the same GPT, and repeat the checks against the saved configuration. The token belongs only on the web service and in this Action configuration; do not place it on workers or replace the generic GPT Access credential with it.

### Disposable PR-preview Action validation

Use this procedure only when the PR preview URL and deployed commit have already been proven to belong to the intended pull request. Do not use the live public GPT or the production hostname.

1. Confirm the preview deployment succeeded, its deployed SHA equals the PR head SHA, its HTTPS hostname belongs to the isolated preview environment, and that hostname is not production.
2. Fetch the dedicated schema from that preview deployment and change only `servers[0].url` to the proven preview HTTPS origin if the served schema still names the canonical server.
3. Create a disposable Custom GPT with an Action-capable non-Pro model and that preview-targeted schema. For query/canary-only validation, do not call the protected source operations. Test source ingestion only with a distinct Gaming source credential configured on the isolated preview web service. Do not modify the live Arcanos Gaming GPT or reuse its production credential.
4. Ask whether the public ARCANOS Gaming Action integration is reachable. Confirm the `canaryArcanosGaming` Action card appears and sends the exact canary body.
5. Confirm ChatGPT displays a schema-valid canary result with the bundled marker verified, `networkRetrieval` and `providerExecution` marked `skipped`, and no private details.
6. Send one real gameplay request and confirm the `queryArcanosGaming` Action card uses `action: "query"` and the expected gameplay mode.
7. When protected preview validation was explicitly authorized, send one benign public HTTPS URL to `ingestGamingSources`, confirm a `202` response, and use only the returned `ingestionId` with `getGamingSourceIngestionStatus`.
8. Correlate only those requests with narrowly filtered preview ingress evidence, then delete the disposable GPT and revoke the preview credential.

Direct HTTPS calls to the preview are useful black-box checks, but they are not full ChatGPT-to-Action end-to-end proof.

## Prompt-fidelity preview proof

The prompt-fidelity merge gate may be satisfied by either a complete saved-GPT Action request card or a single correlated exact-head preview ingress attestation. The attestation is a hash-only prompt-fidelity signal, is disabled by default, and is not a general user-prompt logging mechanism. It must never be enabled in production and never contains raw prompts or URL values.

For the saved prompt `Is Frost Mage viable this patch in World of Warcraft?`, correlated preview telemetry must prove all of the following when the Action request card is unavailable:

- response and attestation request IDs match;
- response and attestation trace IDs match;
- `promptUtf8Bytes` is `53`;
- `promptCodePointCount` is `53`;
- `promptSha256` is `faa37589a5ec8315c14c6a8aecae1172879a060a2965a5a60302d9fca21f2a89`;
- mode is `meta` and game is `World of Warcraft`;
- `guideUrls` is present with a count of four;
- `url`, `urls`, and `guideUrl` are absent with counts of zero;
- sorted payload keys are exactly `game`, `guideUrls`, `mode`, and `prompt`; and
- exactly one Action request occurred in the correlated test window.

Prompt length alone is not sufficient proof. The preview audit must be disabled again after the canary evidence is collected.
