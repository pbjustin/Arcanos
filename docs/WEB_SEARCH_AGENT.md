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

1. Validate and sanitize request input.
2. Apply route-level rate limiting.
3. Resolve the provider through a registry.
4. Search for URLs.
5. Filter and deduplicate results.
6. Fetch page content using `fetchAndClean()`.
7. Create a `SearchPacket` for each fetched source.
8. Capture a bounded cleaned-text snapshot for replay and memory handoff.
9. Optionally traverse extracted `[LINKS]` from fetched pages using a bounded click-through loop.
10. Evaluate the plan with CLEAR 2.0.
11. Optionally synthesize a cited answer from fetched packets.

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
