# Transient Gaming validation profiles

`profiles.json` uses a real public early Samurai guide and a real public Sekiro
combat guide for the wrong-game case. Publisher reachability and source coverage must be
observed at execution; the listed URLs do not guarantee acceptance. The positive
request keeps the starting Uchigatana path and omits a requested patch.

`fixture-profiles.json` separately defines repeatable controlled-source cases for
offline mocks or an approved public validation fixture host. Replace its example
HTTPS origin consistently in `fixtureOrigin`, question links, and `candidateUrls`.
Anonymous fixture routes must return their documents directly, without redirects,
authentication, cookies, signed query parameters, or private network addresses.

Serve `tests/fixtures/gaming-samurai-guide.html` at
`/fixtures/elden-ring-early-samurai.html`. The negative document at
`/fixtures/sekiro-samurai.html` uses the wrong-game source from
`tests/gaming-samurai-guide-workflow.integration.test.ts`.
The controlled source documents make acceptance and rejection repeatable while real
acquisition, parsing, v2 selection, Trinity generation, and mandatory final-answer
audit execute. External publisher availability is a separate validation case.

Both positive profiles expect the existing warning about unverified current patch compatibility.
The source link is an explicit supplied-guide requirement, so the ordinary v2
workflow produces acquisition receipts and the existing evidence verifier can
check supplied-source grounding. The link does not establish source identity or
quality; acquisition and policy still decide those facts.

The adapter accepts any request supported by the v2 Gaming contract. Elden Ring
details belong to these profiles. It forces transient storage policy, isolates
the actor per request, skips stored retrieval, and denies ingestion. Observation
output contains reason codes, counts, qualification flags, audit binding, and
timings. Missing timing hooks remain unobserved; they are never estimated from
overall response time.

Acquisition measures the protected candidate evaluation operation. Selection
measures its subsequent pre-generation evidence assessment. Generation ends when
the mandatory answer audit starts; intake, reasoning, final, and answer audit also
have individual timings. Audit-start budgets come from the actual pipeline and
request context. Response serialization remains unobserved in this adapter and
must be measured by the transport if needed.
