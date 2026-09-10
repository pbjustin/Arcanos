# Request-scoped Gaming guide assistance

The guide-assistance policy is `gaming-guide-assistance/v1`. It extends the
existing Gaming retrieval and Trinity pipeline. It does not create conversation
memory, change configured model identities, refresh sources, or authorize a
deployment.

## Request flow

Previously, intent extraction recognized platform, version, class, role,
difficulty, progress, constraints, and spoiler preferences, but
`BackendQueryAgent.build()` did not forward them. Stored candidate acquisition
used the question and game alone. Trinity intake used a generic framing prompt
with 500 output tokens; reasoning received its framed request without the
original evidence. Grounded guide prompts already answered the question first,
and successful guide composition already passed provider prose through once.

Now the public validator checks bounded optional flat fields, the intent and
backend mapping retain the validated player claims, and the backend validates
again before retrieval. Live and stored lexical retrieval use the same bounded
request/context distinction. Selected evidence enters the Gaming prompt within
its untrusted-data boundary. The ordinary Trinity intake, reasoning, CLEAR, and
final stages retain the original request/evidence, then Gaming projects compact
source-number citations and applies lightweight response composition.

The implementation base is `abb3e89ccfd69f8cb7cfb311ca4cdd7c45c2ab60`, fetched from
`main` on September 7, 2026. Historical request `req_1788735955551_b3xj3` motivated
the mocked incomplete-completion regression. Its historical logs do not prove
the cause of any current production model response.

## Context contract and precedence

Use the existing `game`, `mode`, and `prompt` fields. Optional player fields are
`platform`, `edition`, `version`, `difficulty`, `currentArea`,
`lastCompletedObjective`, `progressPoint`, `class`, `role`, `constraints`,
`spoilerTolerance`, and `answerDepth`. See [API.md](API.md) and
[the Gaming Action schema](../contracts/arcanos_gaming.openapi.v1.json) for
request examples and aliases. No field lets callers adjust server token limits
or select the trusted intake policy.

String caps are 64 characters for platform/version/difficulty/class/role, 120 for
edition, 160 for area/progress, and 240 for the last completed objective.
Constraints allow eight strings of 160 characters each. Aggregate context is
limited to 2,000 characters. Existing 8,000-character prompt, 120-character game,
URL-count/length, structural, and transport body limits remain in force. Unknown
payload fields and invalid enum values are rejected. Server-derived origins,
conflicts, and effective spoiler mode cannot be submitted as public fields.

Explicit fields take precedence over missing-context extraction from the
current question. Strict first-person progress statements can supply missing
area, objective, or checkpoint values. Broad class/role/version extraction is
tentative. Negated and hypothetical progress, a question about defeating a boss,
and areas appearing only in sources do not establish completed objectives.
Contradictory structured/current-question claims are recorded as conflicts;
guidance must ask one targeted question or provide scoped alternatives when the
conflict changes the answer. Source titles do not establish edition or player
state, and explicit precise game titles are preserved.

`answerDepth` accepts `auto`, `concise`, `standard`, or `detailed`. Clear current
question requests for brevity/detail take precedence over the structured depth.
Auto uses concise guidance for next-step/location questions and standard depth
for strategies, walkthroughs, diagnostics, and broader explanation. These are
prompt preferences within existing hard budgets, not output truncation rules.

`spoilerTolerance` accepts `none`, `light`, and `full`, as well as legacy values.
`avoid` maps to `none`; `allowed` maps to `full`; omitted/`unknown` conservatively
maps to `none` without claiming an explicit user preference. Existing accepted
aliases remain supported. When structured and textual preferences disagree, the
stricter permission wins. None permits immediate objectives and essential
mechanics; light permits necessary near-term progression; full permits relevant
spoilers. An inherently spoiler-sensitive question under none gets the safe
portion or one concise clarification. The final Trinity pass retains this
policy and the original constraints.

## Intake completion and budgets

The server-owned `gamingGuideIntakePolicy: compact-v1` is accepted only for the
Gaming module's guide endpoint and guide request. It asks for a plain-text task
card of at most 120 words: question, material player constraints, and evidence
references. It explicitly forbids writing the walkthrough at intake. Original
bounded evidence remains available independently of that card.

The intake allocation remains **500 output tokens**, selected through the
existing provider token-parameter adapter. Supported models receive disabled
reasoning effort for this compact intake task; configured model identities do
not change. There is **no new recovery attempt**. A settled length/incomplete
completion throws `OPENAI_COMPLETION_INCOMPLETE`; no partial text is accepted as
a completed task card or concatenated into an answer. Repeated incompleteness,
provider errors, exhausted runtime, and cancellation remain terminal/degraded.
Successful-looking fallback, dry-run, or incomplete Trinity results are not
promoted to completed guide answers.

Existing default guide budgets remain a 60-second module window, 50-second
pipeline window, 24-second stage window, and 500 ms runtime safety buffer, with
existing request-deadline clamping and session/global provider limits. Ordinary
guide requests retain the full Trinity sequence even when the question asks to
"answer directly". The pre-existing exact-literal compatibility shortcut remains;
the existing self-heal final-stage bypass remains a fallback and cannot become a
completed grounded guide answer. Optional pattern storage and raw audit content are disabled
for this request-scoped guide policy. Non-Gaming behavior remains on its existing
path.

## Retrieval, spoilers, and attribution

`gaming-player-retrieval/v1` separates exact question terms from supporting
area/checkpoint/objective/class/constraint terms. Specific item/boss terms stay
the relevance anchor; for an ambiguous question such as "What next?", player
context supplies that anchor. Platform, generic difficulty, edition/version,
and presentation preferences do not become topical acquisition terms. Candidate
acquisition is bounded to 16 lexical terms and 20 stored candidates.

The existing 25% topical-coverage floor and 65% coverage/35% normalized SQL-rank
score remain. Supporting context adds at most 0.08 to ranking; deterministic
identity ordering resolves ties. Existing duplicate/overlap penalties, active
source/revision constraints, source/chunk caps, and the default 5,000-character
evidence budget remain. No minimum chunk count is imposed. Zero relevant results
remain valid, and supplied-guide zero-evidence suppression still blocks an
unsupported provider call.

Known verified patch mismatches are excluded using existing version comparison.
Unknown edition/version compatibility is not invented. Storage does not provide
trustworthy general game progression chronology or edition metadata, so the
policy does not equate chapter/chunk order with progression or apply speculative
hard progression exclusions.

Conservative spoiler modes select relevant evidence units and omit optional
prose titles/headings from provider and public source presentation. Full mode
can forward sanitized, bounded headings; metadata overhead counts against the
context budget. Internal evidence retains source ID, revision ID, record ID,
public URL, ordinal/offsets, and sanitized headings where available. Several
chunks from the same document keep one public source number. Citations identify
supporting documents; a valid number alone is not proof of claim support.

Lexical filtering cannot guarantee spoiler-free arbitrary prose. An essential
mechanic and a future reveal may share one sentence; source URL paths may reveal
names; pronoun-only dependent passages can be missed. There is no claim of
semantic/paraphrase recall or perfect spoiler detection. The generation policy
must still scope the answer to the question and effective spoiler permission.

The ordinary Gaming/Trinity/module path has no selected-answer cache. The hybrid workflow has a bounded idempotency response cache, described below. Source
document and discovery caches remain enabled. Context-dependent selection runs
after raw cache reads, preserving per-request checkpoint/spoiler decisions and
current stored active-revision reads. No cache is globally disabled. Telemetry
records bounded policy/task/depth/spoiler values, context presence/origins,
candidate/selection counts, context size, and intake completion/usage; it does not
log guide passages, complete private prompts, or hidden model reasoning.

## Deterministic verification and quality evaluation

[The synthetic corpus](../tests/fixtures/gaming-guide-assistance.json) contains
an adventure, an action game, and a ship-systems game. It includes reference
answers and a reusable rubric for clarity, actionability, support, spoilers,
and appropriate detail. For example, the adventure's "What next?" previously
lacked an acquisition anchor; with Copper Canal plus repaired pump, the reference
answer is: "Turn the blue valve beside the canal lift, then cross once the bridge
locks in place. The lit bridge lamp confirms it is ready. [1]"

The action-game case requests a detailed Ash Sentinel strategy despite a
structured concise preference. Its reference answer explains the raised-arm cue,
safe movement, supported punish window, and limits of the difficulty evidence.
The ship case requests a short explanation despite structured detailed depth;
its reference answer explains capacitor charge in two sentences. These are
synthetic reference answers, not measured before/after live-model outputs.

Run the focused corpus with the pinned runtime:

```powershell
node scripts/run-jest.mjs --runInBand --runTestsByPath tests/gaming-answer-policy.test.ts tests/gaming-player-context.e2e.test.ts tests/trinity-gaming-intake.test.ts --coverage=false
```

Mocks prove contracts, stage inputs, selection, safety, bounds, and projection.
They do not prove live model compliance. Live evaluation is disabled by default;
no live-model evaluation, production database test, source refresh, or production deployment
is part of this change. The repository currently has no suitable bounded Gaming
live-model evaluation runner, so no generic live command is repurposed.

## Sealed Railway preview verification

The existing `railway-preview` lifecycle can run the new guide-assistance proof
inside its credential-empty synthetic application. The unchanged sealed guide
request executes the same production pure context, retrieval, prompt/composition,
and compact intake-policy cores over fixed adventure, action, and ship cases.
Success adds `x-arcanos-preview-gaming-guide-assistance-version:
gaming-guide-assistance/v1`; any assertion failure withholds all Gaming success
markers. The supplemental exact-head verifier requires that marker and reports
`gamingGuideAssistanceVerified` within the existing bounded 138-request plan.

This is deployed production-core component evidence. The separate
`gaming-player-context.e2e.test.ts` exercises actual public validation, agent
mapping, configured retrieval composition, Trinity stages and provider adapters
with controlled dependencies. The preview itself does not run those normal
wrappers, a live model, SQL, or an active worker. Follow the exact-head target,
credential-isolation, trusted-verifier, and teardown procedure in
[RAILWAY_DEPLOYMENT.md](RAILWAY_DEPLOYMENT.md); passing fixtures never authorize
production promotion or a source refresh.

### Hybrid knowledge component proof

The same sealed guide request runs
[the hybrid fixture](../src/shared/gaming/gamingHybridKnowledgePreviewFixture.ts)
against the production hybrid schemas, source/freshness policy, and shared
retry-admission, capacity-projection, and approved-refetch predicates. It checks
seasonal questions that also need current patch evidence, malformed applicability
lists, exclusion of conflicting weaker-source mechanics, charged-operation retry
decisions, exact 12,000,000-character retention and one-character overflow, and
changed/filtered/truncated refetch rejection using synthetic hashes.

Success adds `x-arcanos-preview-gaming-hybrid-knowledge-version: gaming-hybrid-knowledge/v1`;
the supplemental exact-head verifier requires it and reports
`gamingHybridKnowledgeVerified`. The guide response body and bounded 138-request
plan remain unchanged. Any hybrid assertion failure returns the fixed
`PREVIEW_GAMING_HYBRID_KNOWLEDGE_CONTRACT_INVALID` error and withholds all Gaming
success markers and the success body. The
[fixture fault tests](../tests/gaming-hybrid-preview.test.ts) and
[served failure tests](../tests/gaming-hybrid-preview-failure.test.ts) verify this
failure boundary.

This fixture establishes served production-core decisions with fixed synthetic
rules, times, and evidence. Schema defaults do not prove consent or authentication
enforcement. It does not run the hybrid workflow cache, request hashing, concurrent
promise reuse, source acquisition, ingestion, queues, SQL, providers, or workers.
The separate mocked
[workflow tests](../tests/gaming-hybrid-workflow.test.ts),
[lifecycle tests](../tests/gaming-hybrid-lifecycle.integration.test.ts), and
[ingestion tests](../tests/gaming-source-ingestion.test.ts) exercise service
composition, actor/payload binding, retry reuse, retained storage handles, and
pre-persistence rejection. The guarded
[PostgreSQL 18 suite](../tests/integration/gaming-durable-rag.pg18.integration.test.ts)
provides separate evidence for real lexical retrieval and active-revision
transactions when executed against an authorized disposable database.

## Custom GPT operator step

### Hybrid knowledge handoff (`gaming-hybrid-v1`)

The additive authenticated Gaming hybrid Actions reuse stored lexical retrieval,
the shared document resolver, existing ingestion jobs, source revisions and chunks,
and the normal Gaming Trinity pipeline. Older gameplay and source Actions retain
their existing request and response shapes. This contract does not make the
backend invoke ChatGPT's web-search tool.

1. `queryGamingHybridKnowledge` receives the question, precise game/edition,
   available player context and storage policy. It checks active stored records.
2. `answer_ready` carries a grounded Trinity answer, citations and request ID;
   `clarification_required` carries one progress question. Neither requires search.
3. `discovery_required` carries bounded queries and limits. The GPT searches and
   calls `submitGamingHybridCandidates` with actual URLs and its workflow ID.
4. ARCANOS independently fetches, validates, extracts, checks applicability and
   selects evidence. Accepted evidence can answer immediately, without storage.
5. `ingestGamingHybridCandidates` is a separate consequential write. It selects
   caller-bound candidate IDs, applies storage permission/consent, and queues the
   existing worker. The existing ingestion-status Action reports the outcome.

`sourceKnown`, `evidenceSelected`, and `freshnessStatus` are independent. A known
catalog entry does not establish coverage. Lookup/auth/provider failures become
temporary unavailability, never an invitation to reinterpret an outage as an
empty corpus. The hybrid path skips Trinity when evidence is missing, stale or
requires progress clarification. It passes the original validated player context,
spoiler/depth preferences, selected evidence and date/update qualifications to
the existing generation and citation projection.

The server permits one discovery round (the existing stricter frontend limit),
three URLs, eight workflows per credential actor, 24 hybrid calls per five
minutes, and 128 workflows total per web process. Workflows expire after ten
minutes; retained resolved text is bounded to 12 million characters per process.
At that capacity, new evidence remains transient and returns no storage handle;
previously retained approvals remain available within their normal lifetime.
The early authenticated parser caps requests at 16 KiB. Candidate fetching has
a 12-second aggregate budget; HTTP hybrid Actions have a 38-second deadline,
including generation. Context remains within the existing Gaming budget. The
same candidate-operation key can resume a failed acquisition without consuming
another discovery round; different keys remain subject to the one-round limit.
GPT may poll status at most three times; the existing status endpoint retains
its shared 120-request/five-minute HTTP rate limit. These in-process transient
limits are not a distributed quota. A different replica or restart can return
`WORKFLOW_UNAVAILABLE`; it must not refetch or ingest from an unbound handle.
An already queued durable job continues without the GPT remaining open.

### Candidate trust and storage

Candidate title, timestamp, claimed publisher, game or patch are untrusted hints.
Only independently retrieved content enters evidence. HTTPS, credentials, query
exposure, DNS/public IP, redirect, media, extraction, cancellation and document
limits use the existing resolver/security path. Prompt instructions in sources
are rejected; source-use restrictions are honored. Inaccessible material is not
replaced by a search snippet. Source policy uses reviewed exact host/path rules
and precise game identity, not search position or a frontend `official` claim.

`transient_only` is the default and cannot be upgraded by a later write in that
workflow. `ask_before_store` requires explicit confirmation and the dedicated
Gaming source credential. `auto_store_approved` additionally requires configured
standing permission and a reviewed official update article with affirmative
patch/hotfix identity and date metadata. Unknown/community sources never qualify
for automatic storage. Live operational status stays transient. Platform Action
confirmations remain required on the explicit write even with standing permission.

An internal artifact binds the credential actor, full accepted content hash,
interpretation/resolver policy and expiry. It is reused for the immediate answer.
Hybrid ingestion stores only the approved extracted prose; embedded structured
planner objects and raw HTML cannot introduce unapproved evidence during refetch.
The durable worker resolves again because its execution may occur on another
process after the request artifact expires; a changed content hash or partial
refetch rejects that approval rather than storing unreviewed content. Idempotency uses the caller and
logical operation key. Same-key retries reuse work; new refreshes use new keys.
Content revision hashing covers all accepted text and indexing policy, not a
preview. Atomic active-revision replacement preserves last valid records on
failed refreshes. An unchanged successful hybrid refresh advances only verified
freshness provenance monotonically under the existing transaction.

Queued/processing is not stored. Completion reports records, extraction coverage,
unchanged, failed and rejected outcomes separately. An independently supported
answer survives a later storage failure. No model training or notifications are
implied. No production-wide backfill, source refresh, new database or historical
revision query path is introduced.

### Freshness and patch applicability

The server classifies each question: stable, patch-sensitive, seasonal or live
status. Revalidation defaults are 30 days for stable evidence, six hours for
official current patch/season verification, and 60 seconds for live status.
These deadlines trigger verification; they do not prove current correctness.
Fetched/verified timestamps are separate from publication, source update,
effective interval, patch, build, season, platform, region and metadata confidence.
Legacy stable evidence may use its last backend fetch date; legacy patch labels
alone never establish the current release.

Dynamic questions require an applicable official current-update index and
compatible gameplay material. Newly fetched old patch notes, missing/contradictory
metadata, future releases and ambiguous date-only rollout-day announcements do
not establish active applicability. Opaque version strings are never sorted to
guess the latest patch. A known current hotfix/build excludes incompatible older
builds; exact declared patch/build baseline applicability can retain unchanged facts. Absence of a
change in newer notes never proves an older fact remains valid. A 304 validates
only that resource, not the absence of updates elsewhere.
Seasonal questions about patches, hotfixes, balance or builds also require current
patch applicability; a season-only index cannot establish it. Malformed or
truncated scope labels remain unverified rather than implying global applicability.

Metadata adapters are intentionally conservative: supported labeled metadata and
the reviewed SWTOR dated release index are implemented. Unsupported site layouts
remain unverified; this is not exhaustive live-service coverage. Bounded explicit
`Mechanic: name = number` labels detect conflicting numeric values (16 per source);
equal-authority conflicts fail closed and conflicting weaker sources are excluded.
An excluded source contributes no other mechanic claims to conflict resolution.
Arbitrary prose semantic conflicts cannot be resolved exhaustively by lexical rules.
Answers must retain that
uncertainty, distinguish official changes from recommendations, and avoid a
currentness claim without verification. Queries for historical/as-of releases
are explicitly unsupported because ordinary retrieval selects active records only.

An accepted official index can be retained as a bounded verification attestation
on the approved source's existing provenance. It is bound to the full approved
artifact hash and reviewed policy, and expires independently under the currentness
rules. Later no-URL retrieval can reuse it while applicable. Its citation contains
server-projected patch/build/season/date facts, not unrelated index story headlines.

See the [canonical GPT package](ARCANOS_GAMING_CUSTOM_GPT.md) for the exact
schema/instruction paths and deployment-before-activation procedure.

This PR updates repository schemas only. After a separately authorized backend
release, open the deployed Gaming Custom GPT in **Edit GPT → Configure →
Actions**, select its existing ARCANOS Gaming Action, and replace its schema with
the complete contents of `contracts/arcanos_gaming.openapi.v1.json`. Preserve
the existing server URL, authentication, and access scope, then save/update the
GPT. If it uses the generic router Action instead, refresh from
`contracts/custom_gpt_route.openapi.v1.json`. This repository PR does not perform
that manual configuration change or authorize backend promotion.

## Gaming CLEAR (`gaming-clear/v1`)

The canonical executable rubric is
[`gamingClearPolicy.ts`](../src/shared/gaming/gamingClearPolicy.ts). Its five
names preserve general CLEAR. Source, evidence and answer are audit subjects,
not alternative expansions of the acronym. The definitions below are checked
against that code by the policy tests.

| Dimension | Gaming judgment |
| --- | --- |
| C — Clarity | Is the information precise and understandable enough to interpret correctly? |
| L — Leverage | How much does the material contribute to the player's actual task? |
| E — Efficiency | Can the material be used proportionately without unnecessary noise or cost? |
| A — Alignment | Does the material apply to this request and its meaningful constraints? |
| R — Resilience | How well does the information remain dependable under uncertainty or change? |

Clarity covers precise game/topic identity, intelligible steps, quantities and
prerequisites, and explicit observations, recommendations, assumptions and
material uncertainty. Polished writing does not establish truth. Missing
platform or patch metadata is immaterial only when irrelevant to the claim.
Leverage measures useful contribution to the player's task against each source's
role. A patch authority may verify a balance change without supporting a full
build. Efficiency measures relevant excerpts and usable structure, duplication,
extraction noise, retrieval cost and requested depth; a long guide is not poor
merely because it is long. Efficiency cannot compensate for unsupported claims.
Alignment checks meaningful game/edition distinctions, player checkpoint,
platform/region/difficulty, requested date/patch/season, spoiler and depth
constraints. Missing facts are not inferred matches. Resilience checks traceable
provenance, claim-appropriate reliability, independent corroboration,
contradictions, superseding changes, partial extraction and honest uncertainty.
Official sources are not sufficient for every claim; community sources are not
automatically false; fetching an old document does not make its facts current.

### Server-owned policy and decisions

`gaming-clear-policy/v1` separates audit profile, question profile and source
role. Requests and source text cannot supply policy weights, floors or approval.
These initial hypotheses are conservative rubric judgments, not calibrated
probabilities or accuracy percentages.

| Question profile | C | L | E | A | R |
| --- | ---: | ---: | ---: | ---: | ---: |
| walkthrough, explanation | .25 | .25 | .15 | .25 | .10 |
| current_build, patch_change, live_status | .15 | .20 | .10 | .30 | .25 |

| Stage | Overall minimum | C minimum | A minimum | R minimum |
| --- | ---: | ---: | ---: | ---: |
| Transient source use | 3.25 | 3 | 3.5 | 3 |
| Durable source quality | 4 | 3.5 | 4 | 3.5 |
| Evidence sufficiency | 3.5 | 3 | 4 | 3 |
| Final answer acceptance | 4 | 3.5 | 4 | 3.5 |

Required currentness raises the R floor to at least 3.5. An aggregate never
compensates for a failed floor or a material blocking finding. Identity,
compatibility, adequate claim support, provenance and acquisition security must
be verified. Freshness can be not applicable for stable claims or for a source
contributing only patch authority/currentness/corroboration; the assembled
current evidence and answer must still independently satisfy freshness.
All five dimensions are required in v1; dimension-level `not_applicable` is
reserved and rejected, preventing removal of an inconvenient dimension.

| Assessment and facts | Decision and consequence |
| --- | --- |
| Completed, all required checks and floors pass | Accept the profile's subject; source quality is not answer sufficiency. |
| Explicit security/game/edition/patch/provenance/support conflict | Reject, regardless of aggregate. |
| Source with only required freshness unresolved | Partial transient contribution pending evidence-level applicability; no durable quality eligibility. |
| Missing required identity, applicability, coverage, or dimension judgment | Clarify or recover; no invented match or optimistic score. |
| Timeout, unavailable provider, incomplete or malformed audit | `unavailable`, null dimension scores and overall; never a completed zero or pass. |
| Fixed clarification without gameplay claims | No model audit required. |

Results bind rubric/policy, profile/role, subject/content hash, request context
fingerprint, method/status, bounded scores, codes and existing evidence IDs.
Overall is computed server-side from strictly validated finite 0–5 numbers.
Strings, booleans, arrays, null evaluated scores, NaN/Infinity, unknown cited IDs,
missing dimensions and model-selected policy/overall/decision are rejected.
Unknown facts remain explicit. Only concise findings are retained, not reviewer
prompts, source dumps or private model reasoning. Player responses do not display
scorecards. Structured telemetry distinguishes audit completion, audit availability,
evidence selection, acquisition, generation and ingestion.

The implementation retains the original URL, DNS/network, redirect, access,
byte/text, timeout, instruction-filtering and source-use controls before scoring.
No score can rescue an acquisition denial or empty extraction. A relevant intact
partial passage may contribute transient evidence while remaining ineligible for
durable ingestion. A reviewed source association and safely extracted game/body
anchors can establish identity without requiring a particular guide-title shape;
a frontend label or a source's `Game:` label alone cannot establish identity.
Broad franchise overlap and explicit incompatible editions remain blocked.

Source roles are `gameplay_guide`, `build_analysis`, `patch_authority`,
`currentness_index`, `live_status`, `community_observation`, and `corroboration`.
Role-appropriate contribution is scored once; publisher reputation, fetch time
and duplicated/syndicated passages are not counted repeatedly as independent
support. A patch note does not prove that no newer hotfix exists or that a build
is best. Current requests use the existing freshness model's publication,
update, fetch, verification, effective interval, patch/build/season and
platform/region distinctions. Historical requests need matching historical
applicability; irrelevant version fields are not required for stable walkthroughs.

Storage requires durable quality **and** allowed source use **and** caller write
permission **and** consent or authorized standing policy **and** all existing
storage requirements. `transient_only` never writes. Actor/content/expiry/policy
bindings and worker refetch validation remain authoritative. Queued, stored,
unchanged, failed and rejected remain separate states. Existing metadata carries
bounded audit provenance; legacy records stay readable without invented prior
Gaming CLEAR scores. Question alignment and freshness are reevaluated on reads.
Source quality is reevaluated before queuing even after an earlier acceptance.
The worker uses bounded, integrity-bound applicability context and the existing
freshness evaluator again before persistence, so an expired interval or currentness
proof cannot remain authorized merely because it was valid when queued. Historical
interval exceptions require verified matching patch evidence; no raw question or
private reasoning is added to the approval payload.

### Evidence and final-answer placement

Source assessment precedes approved hybrid artifacts. Existing lexical search,
complete-document chunk storage and retrieval budgets select relevant passages;
the evidence profile evaluates the actual bounded selected set and its combined
coverage. It preserves zero-result recovery, overlap exclusion and late-document
retrieval. Complementary guides, patch authorities and currentness indexes can
contribute different claims, but individually good sources do not establish a
consistent or sufficient set.

Gaming answer validation evaluates the actual composed substantive response,
with the bounded evidence and player constraints available. It replaces the
Gaming reasoning-ledger CLEAR call; general CLEAR and non-Gaming Trinity retain
their existing behavior. A ledger score is never represented as a final-answer
audit. Citation IDs and claim support, version/currentness, player constraints,
spoilers, depth, useful steps and honest fallback status are part of that answer
judgment. Returned substantive text must match the audited subject hash; changes
to claims or citations cannot carry forward an obsolete pass. Simple-tier low
score retention cannot bypass this Gaming gate.

No repair attempt is added in v1. Material defects, insufficient evidence and
unavailable audits use honest recovery rather than recursively requesting new
answers. This keeps the one-round/three-candidate discovery bounds. Source and
evidence assessments are deterministic and add zero model calls or network
requests. Gaming uses at most one final-answer audit in place of its prior ledger
audit; it uses the configured existing reasoning model and provider adapter,
with no tools or browsing, transport retries fixed to zero and the existing audit deadline
capped by the remaining aggregate request/runtime budget. No production model,
timeout, environment variable or deployment setting is changed.

The final audit permits only server-owned `STYLE_CONCISION`, `STYLE_REPETITION`
and `STYLE_PRESENTATION` warning codes to remain nonblocking. Every other answer
finding is blocking even if the model labels it a warning. Mandatory server
findings override colliding model warnings. Material unresolved answer facts
also block high scores. All model explanation fields are bounded reason codes;
free-text reasoning is rejected by runtime validation, not merely discouraged
by the prompt.

The answer payload contains the actual answer, passages, source/revision/chunk
IDs, applicable game/edition/patch/build/season and verification/effective-time
metadata, and partial-extraction diagnostics. Direct context clipping retains
complete fitting sentences within the existing context cap. Partial extraction
requires bounded claims and material qualifications; it does not establish full
document coverage. Freshness and context are checked immediately before auditing
and again before delivery. Hybrid cached substantive answers also expire at the
earliest actual proof deadline (including live status update age), even when the
workflow itself has time remaining. Expired proof yields
`EVIDENCE_REVALIDATION_REQUIRED` without replaying the answer, issuing additional
model calls or resetting the discovery round.

The one audit call has **1,024 maximum output tokens**, **32,000 maximum data
characters**, **38,000 maximum total prompt characters** including trusted rubric,
**12,000 maximum answer characters**, and a **3,000 ms ceiling** clamped to existing
configuration and remaining runtime/request time. Over-budget input is unavailable
rather than silently truncated or approved. The historical main Trinity invocation
budget counts intake/reasoning, not all auxiliary calls; Gaming uses a separate
explicit single-call audit slot and records its tokens in aggregate totals.
Full Gaming guide generation replaces its old ledger audit with this call.
Paths that previously omitted an audit, including direct/hybrid paths, add at most
one call. There is no additional concurrency fan-out, retrieval round, repair,
provider fallback expansion or timeout increase.

`GAMING_ANSWER_AUDIT_UNAVAILABLE` and `GAMING_ANSWER_REJECTED` are additive bounded
fallback reason values; genuine provider failures retain their existing reasons.
Recovery is not reported as grounded generation. Scores remain internal; no
new public score fields or model reasoning are exposed. Existing general CLEAR
continues to audit ledgers using its prior result/fallback semantics. The only
shared provider change is an optional per-call zero-retry setting whose absent
case retains existing behavior. Three existing pure Gaming fixture digests are
updated for reviewed code changes; the sealed preview import boundary is retained
without importing the Gaming scoring engine or adding effects.

All Gaming guide/build/meta generation uses the existing audit-content redaction
and optional-side-effect suppression flags. This keeps reasoning-ledger content
out of optional pattern/feedback persistence and redacts audit summaries; other
modules retain their previous defaults.

### Calibration and evidence limits

The source/evidence feature mappings deliberately reserve resilience credit:
traceable intact acquisition starts at 3.5 without claiming independent
corroboration; partial extraction has lower resilience and no durable eligibility.
Evidence resilience does not increase merely because copies appear on several
URLs. Lexical coverage and structured contradiction checks are preliminary set
judgments; final semantic support is the answer review's responsibility.

The labeled [calibration corpus](../tests/fixtures/gamingClearCalibration.ts) and
[runner](../tests/gaming-clear-calibration.test.ts) use invented documents across
The Legend of Zelda: Ocarina of Time (static adventure), Elden Ring (action/build),
and Star Wars: The Old Republic (live-service systems). Each profile has nine
calibration and nine separate held-out cases. Cases include supported and
paraphrased passages, mismatched identities/patches, missing support, and uncertain
identity; answer labels include invented mechanics, misleading citation support,
spoiler defects and unavailable assessment. Question-sensitive currentness has
additional focused source, evidence, freshness and workflow fixtures.

| Profile | Calibration cases | False accepts / rejects | Held-out cases | False accepts / rejects |
| --- | ---: | --- | ---: | --- |
| source deterministic policy | 9 | 0 / 0 | 9 | 0 / 0 |
| evidence deterministic policy | 9 | 0 / 0 | 9 | 0 / 0 |
| answer enforcement against supplied gold judgments | 9 | 0 / 0 | 9 | 0 / 0 |

An accept means the rubric decision is `accept`; partial/inconclusive judgments
are not counted as acceptance. The held-out split was evaluated without changing
the proposed thresholds. These small synthetic results exercise policy behavior,
not production recall, calibrated accuracy or live-model judgment quality. In
particular, the answer corpus supplies semantic gold judgments; its zero false
accepts do not demonstrate that a real model will discover those defects.

The historical Elden Ring telemetry identified three outcomes, without exact URL
provenance: identity unverified, redirect disallowed and insufficient extraction.
Synthetic regressions show a legitimate varied title with acquired body identity
can now pass; redirect rejection and zero usable text remain rejected before
CLEAR. No claim is made that all three historical candidates deserved acceptance.
CLEAR does not solve inaccessible pages, disallowed host transitions, rendering,
missing extraction, hidden late-document facts outside selected chunks, or
undocumented gameplay. No source refresh, production reindex, deployment, GPT
Builder edit or live model evaluation is part of this implementation. There is no
existing Gaming CLEAR live-evaluation harness; live evaluation was not run or
silently enabled.

The subsequent [source acquisition policy](GAMING_SOURCE_ACQUISITION.md) preserves
URL identity and permits bounded, explicitly approved HTTPS redirects before
CLEAR. Unapproved redirects and failed acquisition still remain unassessed.
