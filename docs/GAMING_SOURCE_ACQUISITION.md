# Gaming public source acquisition

Gaming discovery proposes URLs. The backend independently admits, acquires,
extracts, and assesses documents before they become evidence. Acquisition success
does not establish the game, edition, current patch, requested gameplay fact,
Gaming CLEAR acceptance, or permission to store a source.

## Confirmed failure classes

At base `da27d1445dd443adc1f1abc7200b38f28acc10ff`, discovery admission assigned
its comparison-only domain normalization back to the request hostname, stripping
`www`. It also sorted query parameters, removed generic `source`/`campaign`
selectors, rejected article URLs containing any `q`/`query` parameter, and
deduplicated URLs after lowercasing case-sensitive resource identifiers. Generic
document public-URL preparation could further discard resource selectors.

The shared HTTP client deliberately denied redirects. Hybrid evaluation mapped
all 3xx exceptions to `REDIRECT_NOT_ALLOWED` and required the resolved public
hostname to equal the admitted hostname. These controls explain reproducible
acquisition failures, not whether any historical rejected page was safe or useful.

The reported Elite Dangerous submission had three acquisition failures
(`URL_BLOCKED`, `REDIRECT_NOT_ALLOWED`, `REDIRECT_NOT_ALLOWED`) with
`gaming.clear.source.not_run`. Its exact URLs and redirect destinations are not
available here. Synthetic fixtures reproduce the failure classes. This change
does not identify or verify a real platinum location.

## URL identity and admission

The standards-compliant URL parser owns request normalization. Policy domain
comparison does not rewrite the acquisition hostname. Paths, case-sensitive
identifiers, retained query bytes, ordering, and repeated parameters survive.
Fragments are validated separately and omitted from the network identity.
Direct structured-build payload interpretation remains a separate bounded path;
payloads are not transferred to a different destination after a redirect.
Existing internally classified structured URLs retain their 16,384-character
initial-document limit. Public hybrid candidates and every redirect destination
remain limited to 2,048 characters. The same admission rules apply to both.
Private build payloads stay out of displayed/cached citations even when article
text supplies the evidence. Self-contained payload fallback requires a proven
zero-hop transport failure; security, redirect, cancellation, and deadline
failures cannot revive or cache that payload as evidence.

Only explicitly recognized analytics parameters are removed: `utm_*`, `fbclid`,
`gclid`, `dclid`, `msclkid`, `mc_cid`, and `mc_eid`. Generic `source`, `campaign`,
`ref_src`, and `ref_url` parameters remain. All original sensitive material is
checked before cleanup; erasing credentials cannot authorize another resource.
The existing parameter-count, tracking-count, and URL-length limits remain.

Article query selectors are allowed. Root/index search queries and explicit
`/search`, `/search-results`, and `/results` paths remain excluded. Public forums
are not categorically unsafe. Existing social/content-farm, shortener, account,
document-type, domain deny, and configured allowlist restrictions remain.
Archive's recognized item/derivative rules remain specialized; sensitive material
is rejected before canonical item selection.

Public consumers retain coarse reason codes. Operator diagnostics add finite
security/source-policy categories, admission rule identifiers, acquisition stage,
opaque candidate reference, submitted index, workflow/request correlation,
redirect count, zero-based failing hop, HTTP status category, policy version,
and elapsed time. They do not include rejected URLs, Location headers, transport
addresses, client configurations, bodies, cookies, or credentials.

## Explicit HTTPS redirect policy

`gaming-https-acquisition-v1` lives in the shared Gaming document resolver.
Neither a frontend field nor generic fetch options can enable redirects.
Low-level automatic redirects remain disabled (`maxRedirects: 0`). Every request
is GET-only. Only 301, 302, 303, 307, and 308 can produce another request.
Relative Location values resolve against the logical URL, never its pinned IP.

| Transition | Required rule |
| --- | --- |
| Same origin | Destination independently passes admission. |
| `icy-veins.com` / `www.icy-veins.com` | Both paths begin `/wow/`. |
| `swtor.com` / `www.swtor.com` | Both paths equal `/patchnotes` or begin `/patchnotes/`. |
| Archive derivatives | Existing Archive resolver policy, without generic redirect privileges. |
| Any other cross-host transition | Rejected before destination DNS/connection. |

The two hostname pairs come from the existing reviewed publisher catalog. They
are explicit server-owned policy, not historical URL attribution or a claim of
live website behavior. Suffixes, registrable domains, certificates, frontend
labels, canonical tags, and sibling subdomains establish no transition trust.

Missing, duplicate, malformed, ambiguous, oversized, or whitespace-bearing
Location values fail closed. HTTPS downgrade, credentials, forbidden ports,
disallowed pages, loops, and more than three transitions are rejected. A 304
without existing conditional content is unusable; it is never followed. HTML
meta refresh, JavaScript, links, and claimed canonical URLs do not trigger fetches.
Legacy HTTP compatibility retains its original direct, redirect-denying transport;
hybrid candidates require HTTPS. The development localhost opt-in does not apply
to the new HTTPS session.

## Transport bounds and resource cleanup

Each hop resolves A and AAAA through the controlled resolver, rejects any unsafe
answer including mixed public/private results, chooses one validated address,
and connects to that exact IP. Host and TLS/SNI retain the logical hostname;
normal certificate and hostname verification remain enabled. There is no second
hostname fetch, address fallback, retry, HEAD probe, proxy, or cookie jar.
An isolated Axios core client cannot inherit global auth, params, headers,
interceptors, custom adapters, or transforms. Outbound headers are explicitly
limited to Host, User-Agent, Accept, and Accept-Encoding.

IPv6 normalization also catches expanded mapped-private representations. The
Gaming session permits ordinary global unicast `2000::/3`, excluding reserved,
special-purpose, 6to4, and documentation ranges; mapped/compatible, NAT64,
discard, local, and multicast forms are excluded from this path.

Three transitions mean at most four requests per candidate. Hybrid retains
three sequential candidates, a 12-second batch ceiling, and its existing
per-candidate ceiling (at most five seconds, or a stricter configured timeout):
at most twelve requests if time remains. There is no redirect fan-out. The
existing ingestion source count and surrounding concurrency admission remain.

One absolute deadline spans DNS, connection/TLS, redirect bodies, final transfer,
decompression, and extraction. Every response shares the existing byte allowance
(default 1,500,000 bytes, configured hard ceiling 5,000,000); both aggregate wire
and decoded bytes are metered separately against that same allowance. Redirect
bodies consume it too. Headers and Location are bounded. Synchronous extraction
is bounded by document size and checked against the same deadline before/after
processing; expiration does not admit late evidence. Live text remains capped at
100,000 characters and durable text at 1,000,000, with explicit partial coverage.
Cancellation stops the DNS resolver and active streams. Bodies, decoder/meter
streams, agents/sockets, listeners, and timers are released on every exit.

## Provenance, approval, and durable identity

Generic acquired documents retain exact requested/final acquisition identities
internally and derive a separate public citation URL. Recognized structured-build
payloads are removed from that citation even when a redirect supplies useful
article text. Admission validates decoded path components, including encoded
slashes, without rewriting accepted request bytes. Documents also carry policy
version, approved transitions, redirect count, content type, and extraction
coverage. A private in-process attestation
binds that record to document identity, content, metadata, and extraction result.
Missing, copied, or modified HTTPS attestations cannot authorize a transition.
Transport IP URLs never become citations.

Hybrid and live retrieval use final publisher/content policy. An official
starting URL does not confer authority outside its reviewed final path. Live
redirect results are not reused from the document cache; subsequent acquisition
revalidates the original chain. Direct cache entries include acquisition policy
in their keys and preserve verified identity.
Current caller/catalog hints are reapplied when reading a direct document cache;
cached text cannot replay older authority, game, or stability hints.
Hybrid artifacts bind caller scope,
full content, requested/final identities, transition record, resolver/acquisition
policy, source policy/freshness, and Gaming CLEAR applicability context.

Queued ingestion refetches the original URL with the same resolver. Changed
content, destination, or provenance invalidates the previous approval. New
sources deduplicate on the observed final canonical identity; unrelated URLs
with similar text are not merged. Refresh preserves existing source IDs and
canonical keys, re-fetches the original request from revision provenance when
available, and reassesses final content/publisher policy. Changed evidence
creates a revision and updates citations through existing atomic persistence.
Older sources without that provenance use their existing canonical URL. No
database migration or production-wide identity rewrite is required.
Unchanged ordinary ingestion and legacy refresh retain their existing idempotency
fingerprints; new acquisition identity fields contribute only when populated and
different from the canonical request.

## Recovery and evidence limits

Pre-assessment acquisition failures retain `gaming.clear.source.not_run` and do
not receive fabricated scores. When every supplied candidate fails acquisition,
the existing hybrid `reason` is `SOURCE_ACQUISITION_UNVERIFIED` and `qualification`
explains that backend acquisition could not verify the supplied sources. That
does not establish that no public guide/location exists. The discovery limit and
stop behavior remain unchanged.

Deterministic DNS/HTTP fixtures exercise the actual public hybrid route,
resolver, ingestion/refetch/refresh, stored retrieval, and large guides. Local
HTTPS socket fixtures additionally exercise pinning, Host/SNI, certificate
rejection, environment/default isolation, cancellation, and compressed limits.
In-memory repository fixtures do not prove PostgreSQL locking or FTS. No live
website, model/provider, production ingestion, deployment, or GPT Builder change
is required for these tests. JavaScript-only pages, login/CAPTCHA/paywall flows,
unsupported formats, unapproved host transitions, and absent gameplay details
remain limitations.
