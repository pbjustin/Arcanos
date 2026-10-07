# Transient Gaming validation profiles

[profiles.json](profiles.json) defines the two reusable data-driven acceptance
cases for the single [Railway validation service](../../docs/LIVE_VALIDATION.md).
The positive Elden Ring Samurai case follows the starting Uchigatana immediately
after the tutorial, without an explicit edition or patch. It requires real public
acquisition, grounded evidence, Trinity generation, a completed mandatory CLEAR
answer audit and admitted-source citations. The negative case supplies a Sekiro
combat guide and requires a preserved conflict with no unsupported generation.
Publisher reachability and coverage must be observed at execution; a listed URL
is not evidence of acceptance.

[fixture-profiles.json](fixture-profiles.json) supplies controlled offline cases.
Its example HTTPS origin is a placeholder, not a deployed source host. If a public
fixture host is separately established, replace `fixtureOrigin`, question links
and `candidateUrls` consistently. Anonymous fixture routes must serve documents
directly, without redirects, authentication, signed parameters or private-network
addresses. The positive document is
`tests/fixtures/gaming-samurai-guide.html`; the negative wrong-game document is
in `tests/gaming-samurai-guide-workflow.integration.test.ts`.

The existing v2 Gaming adapter forces transient storage, isolates the actor per
request, skips stored retrieval and denies ingestion. It preserves mandatory
answer audit, source compatibility, freshness and citation protections. Unknown
current patch compatibility remains visibly qualified; a meaningful clarification
is recorded honestly and never counted as an audited generated answer.

Observations contain sanitized acquisition, evidence selection, generation,
mandatory answer audit and response-construction statuses/timings. Missing hooks
remain unobserved. They contain no prompt, full source/answer, hidden reasoning or
secret. The profiles share one bounded run: USD 2, 32 provider requests, two
workflows, one concurrent provider request, ten minutes and zero automatic
retries. No local fixture establishes a Railway or paid provider result.
