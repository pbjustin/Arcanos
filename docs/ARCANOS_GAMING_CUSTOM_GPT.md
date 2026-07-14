# ARCANOS Gaming Custom GPT

This is the builder-facing configuration for the existing **Arcanos Gaming** Custom GPT. ChatGPT Web Search may discover candidate URLs, but ARCANOS remains the only evidence authority.

## Action configuration

- Import schema: `https://acranos-production.up.railway.app/contracts/arcanos_gaming.openapi.v1.json`
- Schema version: `1.4.0`
- Canonical server: `https://acranos-production.up.railway.app`
- Authentication: None
- Recommended model: select a supported non-Pro model that can invoke Actions; do not leave this unset.
- Enable both Actions and Web Search.
- Do not add a second ARCANOS schema configuration or use a retired ARCANOS deployment hostname; the imported schema contains both supported operations.

Users can still switch away from the recommended model. Pro mode does not support custom GPT Actions, so requests that require backend access must use an Action-capable non-Pro model.

The dedicated schema defines exactly two fixed-path operations:

- `queryArcanosGaming` → `POST /gpt/arcanos-gaming` for `guide`, `build`, and `meta` gameplay requests.
- `canaryArcanosGaming` → `POST /gpt/arcanos-gaming/canary` for bounded public Action-pipeline verification.

The `ARCANOS:GAMING` module still exposes only `query`. `canaryArcanosGaming` is a route-level public protocol: it never enters gameplay, the writing pipeline, provider execution, conversation persistence, or control-plane code. Public Gaming gameplay calls require body `action: "query"`; neither operation selects its action from a query parameter, header, or operation alias.

## Builder instructions

Add the following workflow to the GPT instructions without weakening the existing ARCANOS Gaming scope or safety rules:

```text
ARCANOS is the only evidence authority for Gaming answers.

Model compatibility

If the ARCANOS operations are unavailable because the current ChatGPT mode does not support Actions, do not report an ARCANOS backend outage. Ask the user to switch from Pro mode to an Action-capable non-Pro model, then retry the request.

Action selection

Use queryArcanosGaming only for gameplay guides, builds, and meta questions. Its request body must use action "query".

Use canaryArcanosGaming only when the user asks whether the public ARCANOS Gaming Action integration is reachable or implemented. Invoke it with exactly action "canary" and payload.scope "public_pipeline". Do not silently rewrite an operational request into gameplay or silently rewrite a gameplay request into a canary.

Route selection must use only the validated Action request and the user's original prompt. Never copy Web Search titles, snippets, source text, retrieved HTML, provider output, translations, or enriched context into route selection.

If a gameplay call returns OPERATIONAL_REQUEST_NOT_GAMEPLAY, explain that the request is about the public integration and invoke canaryArcanosGaming if the user asked for that check. A request such as "Reach my backend and see if this has been implemented correctly." is operational. Gameplay questions such as "How do dedicated server settings affect Pal spawning?" and "Is this early-game base build working correctly?" remain gameplay.

The canary proves only the public stages named in its response. Never present it as proof of provider execution, source-network retrieval, private infrastructure health, or administrative health.

Stable gameplay requests

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
```

## Workflow examples

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

Pass the supplied URL through `url`, `urls`, `guideUrl`, or `guideUrls` in the single `queryArcanosGaming` call. Web Search is optional only when more candidates are needed before that call.

### All candidate URLs rejected

Present the controlled ARCANOS response, including its safe fallback or discovery reason. Do not use rejected pages, search titles, or snippets to fill gaps.

## Public canary scope

The canary validates the exact request envelope, selects the fixed public canary route, loads the bundled stable fixture, verifies marker `ARCANOS_PUBLIC_CANARY_7F31`, performs its deterministic grounding/projection, constructs the response, and applies the canary response guard. A successful result reports those stages as passed, one accepted bundled source, and no fallback.

Network retrieval and provider execution are intentionally reported as `skipped`. The canary does not fetch a remote source and does not call a model provider. It is not an administrative health endpoint and cannot expose logs, secrets, credentials, environment values, infrastructure or deployment details, filesystem paths, jobs, queues, databases, workers, or control-plane data.

## Release procedure

Updating this repository does not update the external Custom GPT automatically. After the exact schema is deployed, re-import it into the existing Arcanos Gaming GPT, preserve its current authentication and visibility, select a supported non-Pro recommended model that can invoke Actions, run stable and current-request Preview checks, save, reopen the same GPT, and repeat the checks against the saved configuration.

### Disposable PR-preview Action validation

Use this procedure only when the PR preview URL and deployed commit have already been proven to belong to the intended pull request. Do not use the live public GPT or the production hostname.

1. Confirm the preview deployment succeeded, its deployed SHA equals the PR head SHA, its HTTPS hostname belongs to the isolated preview environment, and that hostname is not production.
2. Fetch the dedicated schema from that preview deployment and change only `servers[0].url` to the proven preview HTTPS origin if the served schema still names the canonical server.
3. Create a disposable Custom GPT with no authentication, an Action-capable non-Pro model, and that preview-targeted schema. Do not modify the live Arcanos Gaming GPT.
4. Ask whether the public ARCANOS Gaming Action integration is reachable. Confirm the `canaryArcanosGaming` Action card appears and sends the exact canary body.
5. Confirm ChatGPT displays a schema-valid canary result with the bundled marker verified, `networkRetrieval` and `providerExecution` marked `skipped`, and no private details.
6. Send one real gameplay request and confirm the `queryArcanosGaming` Action card uses `action: "query"` and the expected gameplay mode.
7. Correlate only those requests with narrowly filtered preview ingress evidence, then delete the disposable GPT.

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
