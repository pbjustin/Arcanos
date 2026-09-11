# Web Search Agent with CLEAR 2.0

This feature adds a grounded web-search pipeline to ARCANOS.

## Route

`POST /api/web/search`

## Request body

```json
{
  "query": "latest OpenAI API pricing",
  "provider": "auto",
  "limit": 5,
  "fetchPages": 3,
  "pageMaxChars": 9000,
  "includePageContent": true,
  "synthesize": true,
  "synthesisModel": "gpt-4o-mini",
  "allowDomains": ["openai.com"],
  "denyDomains": ["example.com"],
  "traverseLinks": true,
  "traversalDepth": 1,
  "maxTraversalPages": 2,
  "sameDomainOnly": true,
  "traversalLinkLimit": 3
}
```

## Flow

1. Apply the shared public-provider admission boundary and route-level rate limiting.
2. Validate and sanitize request input.
3. Compute the CLEAR decision from the query and normalized options.
4. Resolve the provider through a registry.
5. Search for URLs.
6. Filter and deduplicate results.
7. Fetch page content using `fetchAndCleanDocument()`.
8. Create a `SearchPacket` for each fetched source, including a bounded cleaned-text snapshot for replay and memory handoff.
9. Before optional traversal, check the earlier CLEAR decision; when it is not `block`, traverse extracted `[LINKS]` using the bounded click-through loop.
10. Before optional synthesis, check provider configuration and the CLEAR decision; when configured and not blocked, synthesize a cited answer from fetched packets.

Uncaught provider-search and execution failures return `500` with
`{ "ok": false, "error": "WEB_SEARCH_FAILED", "message": "Web search failed." }`
plus a timestamp. This outer route error uses fixed public text.

The service handles individual page-fetch and optional synthesis failures
separately, returning available packets with `answer: null` when synthesis
fails. **Known implementation gap:** these inner handlers currently copy
`resolveErrorMessage(...)` into public `notes` and fetch-error metadata.
The fixed outer `500` message therefore does not establish redaction for a
successful partial response. Sanitizing those projections requires a separate
code change; clients should treat them as untrusted diagnostics.

The route schema in `src/routes/web-search.ts` requires a 1–1000-character
query and validates integer bounds: `limit` 1–10, `fetchPages` 1–5,
`pageMaxChars` 1000–12000, `traversalDepth` 1–2, `maxTraversalPages` 1–5,
and `traversalLinkLimit` 1–8. Invalid input returns `400`; throttling returns
`429`. `synthesize` defaults to `false`, while `includePageContent` defaults
to `true`. Examples that enable synthesis can incur provider calls.

`WEB_SEARCH_TIMEOUT_MS` bounds each search-provider HTTP request, not the
entire workflow. Sequential page retrieval and optional Trinity synthesis use
their own execution limits (`src/services/webSearchAgent.ts`, `fetchText`,
`webSearchAgent`, and `synthesizeSources`).

## SearchPacket schema

Each source is returned as a versioned packet with:

- `packetVersion`
- `clearPolicyVersion`
- `sessionId`
- `packetType`
- `intent`
- `policy`
- `snapshot`
- normal source fields like `url`, `title`, `fetchedAt`, `contentHash`, `metadata`

The packet makes it easier to:
- replay retrieval sessions
- keep short-lived snapshots for audit
- attach policy context to later memory writes
- rerank or cluster packets later

## Snapshot behavior

Each source packet includes a cleaned-text snapshot:

- `snapshot.kind`
- `snapshot.available`
- `snapshot.excerpt`
- `snapshot.charCount`
- `snapshot.truncated`
- `snapshot.capturedAt`
- `snapshot.contentHash`

Snapshots are bounded by `WEB_SEARCH_SNAPSHOT_CHARS` and are meant for:
- audit replay
- memory review
- lightweight packet inspection without storing the entire page body

## CLEAR integration

`webSearchAgent()` builds a small execution plan and scores it with `buildClear2Summary()`.

This gives each search request a governance score covering:
- clarity
- leverage
- efficiency
- alignment
- resilience

The result is returned under `clear`, and each packet is stamped with:
- `clearPolicyVersion`

A `block` decision skips optional traversal and synthesis, but the current
implementation still performs provider search and initial page fetches.
`confirm` is not an interactive confirmation challenge on this route. Packets
and scores do not independently authorize durable memory writes.

## Traversal behavior

When `traverseLinks` is enabled, the agent can "click through" links discovered in the cleaned page output.

Guardrails:
- `traversalDepth` is capped at 2
- `maxTraversalPages` is capped at 5
- `sameDomainOnly` defaults to `true`
- discovered links are deduped by URL
- obvious binary / download targets are skipped
- allow/deny domain filters apply to traversed links too

Traversal packets include additional metadata:
- `sourceType`
- `depth`
- `parentUrl`
- `parentSourceId`
- `linkLabel`
- `traversalScore`

## Extension points

- add more `SearchProvider` adapters
- add provider health checks
- cache search and fetch results
- rerank official sources before fetch
- persist packet snapshots into an ephemeral memory buffer
- require `clear.decision === "allow"` before synthesis in stricter deployments
- promote packets to long-term memory only after policy checks
