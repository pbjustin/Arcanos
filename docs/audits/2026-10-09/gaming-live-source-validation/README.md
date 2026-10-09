# Gaming live-source validation incident, 2026-10-09

This audit concerns the early-game Elden Ring Samurai bleed request on PC/Steam,
solo PvE, base-game content, Uchigatana, through level 50. The protocol was
`gaming-hybrid-v2`; storage was `transient_only`. It does not contain a generated
build guide or copied publisher content.

## Incident and deployment evidence

Baseline: `0ec167654fa3970c818b2e2721c044dd79b77189`, the merge of
[PR #1530](https://github.com/pbjustin/Arcanos/pull/1530).
The fresh read-only Railway retrieval covered 01:10:30–01:13:30 UTC.
[Sanitized incident evidence](incident.json) retains bounded diagnostic counts,
rule codes, workflow/candidate/request correlation, public DNS names, HTTP
statuses, and network timing. It omits documents, request bodies, credentials,
cookies, private addresses, and raw transport errors.

| Operation | Request ID | Application trace ID | Result |
| --- | --- | --- | --- |
| Initial query | req_1791508281422_9pzj9e | trace_1791508281422_75m15h | Revision 0, discovery requested |
| Initial candidates | req_1791508306329_3k8afw | trace_1791508306330_pcefss | Revision 1, all three rejected |
| Recovery candidates | req_1791508332075_sojg8g | trace_1791508332075_3yg49c | Revision 2, all three rejected; stop, recovery 0 |

Workflow: `c3910525-ba66-4a0f-bc4d-786057d0ee8a`. Every operation returned HTTP
200 on `/chatgpt/gaming/mcp`; no operation selected evidence or produced an
answer. The terminal workflow must not be retried. Railway distributed tracing
was disabled, so there are no W3C traces to correlate. Application trace IDs are
not Railway W3C trace IDs. Worker logs contain no Gaming event correlated to
this workflow. DNS lookup records and public HTTPS egress records belong to the
web deployment; they establish network activity, not publisher content identity.

[Deployment identity evidence](deployment-identity.json) links the exact
[GitHub rollout checkout and job](https://github.com/pbjustin/Arcanos/actions/runs/37867543003/job/113617869732)
to worker `b046e807-81b2-4e72-aa6a-75e03c4c013d` and web
`19425909-ec6f-46c1-a42e-a5b913fe2f32`. The reviewed observer uploads the current
checkout; no tracked mutation appears between checkout and either upload.
Railway build logs identify both resulting image digests. Railway source commit
metadata is null, web startup says `git=unknown`, and the job did not emit a
pre-upload tree digest or cleanliness attestation. Thus the expected-source
upload chain is corroborated, while independent artifact-to-SHA attestation
remains unavailable. A read-only health GET identified the exact live web
deployment; startup and liveness do not prove Gaming acceptance.

## Publisher outcomes and diagnosis limits

| Publisher / submission index | Fresh diagnostic observations | Interpretation |
| --- | --- | --- |
| Mobalytics / initial 0 and recovery 2 | HTTP 403; transport `HTTP_RESPONSE_UNUSABLE`; `SOURCE_INACCESSIBLE` | Publisher denied access. DNS succeeded; recorded HTTPS egress has no drop cause. No evidence establishes a different transport cause or permission to bypass. |
| PC Gamer / initial 1 | 2,096,257 decoded bytes; 285,320 extracted characters; 101 selected units, 9 complete, 92 partial; `GAME_MISMATCH` | Identity rejection occurred after extraction. Partial reasons include `required_context_missing`, `content_truncated`, `incomplete_record`. Ordinary-paragraph and wrapper-context defects can create false incompleteness; genuinely truncated units remain incomplete. |
| GamesRadar / initial 2 | 2,233,809 decoded bytes; 1,057 extracted characters; zero selected units; `INSUFFICIENT_EXTRACTION` | HTTP acquisition succeeded; extraction was unusable. Synthetic publisher-shaped reproductions establish card-selection and presentation-table prose loss independently. The exact original container is not known. |
| GameGuide / recovery 0 | 186,249 decoded bytes; 89,677 extracted characters; 107 partial units, zero complete; `GAME_MISMATCH` | The only recorded aggregate subreason is `required_context_missing`, without output truncation. The ordinary-paragraph context-count defect explains this failure class; identity rejection is a separate decision. |
| togame.io / recovery 1 | 29,521 decoded bytes; 8,988 extracted characters; two partial units; `GAME_MISMATCH` | Partial units report `content_truncated`. Those units are not promoted. Generic-title and declaration defects explain reproducible false-identity failure classes; the exact original offending span is unavailable. |

These are fresh diagnostics, not recycled observations. Publisher bodies and
exact candidate URLs were not logged. Historical diagnostics lacked identity
rule/category identifiers. Consequently no exact publisher sentence, HTML shape,
or particular identity rule can be attributed with certainty. `GAME_MISMATCH`
does not establish that an acquired page was actually about a different game.
No new production query or independent publisher reacquisition was performed.

## Narrow corrections

- Share a bounded declaration grammar between source identity and freshness.
  Ordinary `early game:` prose is not a title declaration. Explicit parser-owned
  HTML metadata fields retain their acquired boundaries after prose normalization.
- Reject invented identities from a closed set of generic gameplay topic words.
  Acquired document titles, explicit fields and affirmative body scopes continue
  to detect genuine different games, Nightreign, and contradictory declarations.
  A leading heading corroborated by the acquired article opening retains its
  subject identity, including after HTML whitespace normalization. Pooled
  recommended headings cannot assert a conflicting subject or supply positive
  game/edition proof that is absent from the article itself.
- Add deterministic identity rule/category diagnostics through existing structured
  source logs, preserving workflow, request, trace and candidate correlation.
  Diagnostics contain no source text or user prompt. An early freshness game
  classification rejection reports its own rule instead of substituting a later
  CLEAR assessment's unrelated identity rule.
- Prefer an independently readable primary article over generic content cards for
  Gaming extraction, using the existing scoring thresholds and selector bounds.
- Count applicable qualifier candidates instead of every ordinary paragraph.
  Complete whole-article context can cross ordinary layout wrappers; omitted
  semantic ancestors or actual qualifier overflow still make records partial.
- Apply furniture exclusions to structural admission and inherited qualifiers,
  including embedded JSON. Excluding sidebar prose alone did not prevent the
  same unrelated text becoming a serialized qualifier and triggering a mismatch.
  Comment wrappers retain eligible primary community posts without unrelated
  sibling prose. Schema labels remain selection hints, not trust assertions.
- Preserve authored prose in explicit presentation tables while removing nested
  data structures from fallback prose. Incomplete or conflicting records retain
  their integrity classification and cannot become affirmative prose facts.
- Remove longer structural serializations before overlapping short metadata
  fields, preserving mixed-edition exclusion and freshness interpretation.

No byte, decoded-character, DOM-element, parser, deadline, unit, context or
generation limits are increased. HTTPS/SSRF, redirect/private-network admission,
source-use restrictions, injection filtering, edition/currentness/conflict gates,
provenance and transient-only storage policy remain authoritative.

## Verification boundaries

The new regression documents are invented publisher-shaped HTML, including
primary article/card competition, long prose, closed metadata fields, nested
records and presentation tables. Existing negative suites retain wrong-game,
Nightreign, DLC, currentness, unsafe transport, injection, truncation, conflicting
records, provider suppression and storage suppression coverage. The PR records
the actual final commands, totals, exact commit SHAs, independent CI runs and
PostgreSQL results; historical failed runs remain visible.
[Baseline identity reproduction](baseline-identity-reproduction.json) records
eight actual positive assertion failures and five passing negative controls on
the exact baseline sources. [Baseline extraction reproduction](baseline-reproduction.json)
records three actual extraction assertion failures. These isolate code defects;
they do not identify the missing historical publisher spans.
[Baseline pooled-anchor reproduction](baseline-pooled-anchor-reproduction.json)
records two pre-existing false positive game/edition identity decisions, with
paired uncontaminated controls. They are distinct from the incident's observed
false mismatch classes.
[Regression inventory](regression-inventory.md) maps requirements to executable
fixtures and retained negative coverage.
[Pre-commit verification](precommit-verification.json),
[disposable PostgreSQL verification](postgres-verification.json), and
[local preview verification](local-preview-verification.json) record executed
checks and their source fingerprints. Independent GitHub results and the exact
committed checkout are recorded in the PR after publication.

The preserved `gaming-guide-negative` example profile serves an HTML-named raw
GitHub fixture as plain text. Its normalized text loses the metadata paragraph
boundary, so the corrected grammar rejects it as `GAME_IDENTITY_UNVERIFIED`
instead of asserting `GAME_MISMATCH` from an embedded substring. No provider or
storage call follows either rejection. The existing profile's expected
`semanticGap: CONFLICT` remains a known expectation mismatch; the configuration
is unchanged and that paid/live profile was not dispatched. Separate genuine
plaintext declarations and properly served HTML wrong-game fixtures retain
strict `GAME_MISMATCH` coverage.

The added `gaming-live-source-validation/v1` served proof covers fixed pure
identity, extraction/projection and structural-integrity assertions. Its
independent PR-head verifier requires the new header and fails on absence or
version drift. The sealed import graph and semantic digests retain the reviewed
credential-free boundary. It does not run publisher acquisition, production SQL,
active queues/workers, or Trinity providers.
Primary article-container scoring lives in the network-capable shared fetcher,
which remains excluded from the sealed import graph; its regression is verified
by focused local resolver/fetcher tests, not by the served pure fixture.

The maintained preview controller requires a same-repository, open, non-draft
`main` PR with the `railway-preview` label. This mission requires a draft PR;
that missing non-draft admission blocks a trusted hosted preview. The controller
and guards are unchanged. Local served fixture checks, dry-run validation and
verifier unit tests cannot substitute for executed hosted HTTP evidence. No
preview environment is created, adopted, relabeled, or deleted to bypass the
guard. The PR records the current absence of an owned preview and cleanup status.

## Production acceptance after separately authorized rollout

1. Obtain authorization for production rollout and the specific real Gaming
   query/provider operation. Record the approved release SHA, independently
   verified web/worker deployment identity and rollback target. Existing CI or
   sealed fixture success does not grant production authorization.
2. Use the original request exactly: “Look up an early-game Samurai bleed build
   for Elden Ring. PC/Steam, solo PvE, base-game content only, Uchigatana-focused,
   through level 50.” Start one new `gaming-hybrid-v2` workflow with
   `storagePolicy: transient_only` and a new idempotency key. Never resume the
   incident's terminal workflow or reuse its candidate identities.
3. Follow the response's workflow ID, revision, discovery type, expiry and
   candidate allowance. Submit only independently accessible public HTTPS guides
   authorized for acquisition. Prefer alternatives to observed HTTP 403 URLs;
   do not bypass publisher restrictions. Use at most the granted candidate batch.
4. Require real accepted acquisition diagnostics and source identity/applicability
   verification. Inspect the rule/category if rejection occurs; retain actual
   extraction counts, integrity and selected records. A fetch, metadata label,
   startup, or diagnostic HTTP 200 alone is insufficient.
5. Require evidence selection with valid URL/source/revision provenance and full
   requested topic coverage, or explicit supported limitations. No incomplete
   record may establish an unqualified fact. Currentness must meet the actual
   policy; advisory unknown currentness must remain visibly qualified.
6. If the protocol grants replacement discovery, use only that same workflow's
   remaining recovery, latest `expectedRevision`, TTL and URL/time budgets. An
   identical permitted replay retains its key and payload; a distinct operation
   uses a new key. Do not restart, replenish or retry terminal/expired workflows.
7. Require an actual Trinity result accepted by final answer validation, containing
   valid citations to selected evidence and preserving all base-game, progress,
   solo-PvE, platform, bleed applicability and freshness limitations. Fixture
   provider outputs are not a live answer.
8. Confirm zero durable source-ingestion writes under `transient_only`. Record
   exact query, candidate and answer diagnostic request IDs, trace IDs, workflow,
   release/deployment identity and bounded outcome evidence. Do not log documents
   or private player data.
9. On any failed acceptance condition, record its exact stage/rule and stop. Do
   not manufacture an answer, launch generation retry, change configuration, or
   perform an unapproved rollout. Declare functional verification only after all
   above conditions actually pass.

## Rollback

The patch changes source interpretation and extraction, not schemas or production
configuration. A separately authorized rollback returns both roles to the
approved baseline, preserving unrelated environment state. No migration or
backfill is required. Source revisions created by a future authorized durable
ingestion must remain governed by their existing revision/provenance policy;
transient-only acceptance creates none. Record rollback deployment identity and
re-run the bounded, separately authorized acceptance procedure before claiming
functional recovery.
