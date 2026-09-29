# Gaming migration checkpoint

Arcanos Gaming is a private, single-owner migration. The initial fetched main
baseline was `8f31f3eb5c95af1919e5a36e780cfb75e011a7a9`, including PR #1509.
The migration branch is `codex/arcanos-gaming-plugin-migration`.

**The draft migration remains release-blocked.** The separate backend
prerequisite [PR #1515](https://github.com/pbjustin/Arcanos/pull/1515), approved
at `a5250617102513447f75d22fa85aff3055f74f04`, was owner-authorized, merged and
deployed as `4db5f9db8c8baa12cb3c26b69dac32a8520b6852`. Its merge tree matches
the approved head. [Migration PR #1514](https://github.com/pbjustin/Arcanos/pull/1514)
reconciles that main baseline; its final merge remains unauthorized.

The approved baseline and valid local composition tooling are sufficient to
prepare the private skill for local owner review. Backend acceptance remains a
separate activation and release gate; it does not block instruction composition.

## Backend deployment and bounded read evidence

The [maintained production workflow](https://github.com/pbjustin/Arcanos/actions/runs/36455211881)
succeeded worker-first, then web. Worker deployment
`8fcc9e4b-779b-4e51-b987-a90d18c267bd` and web deployment
`e543ed1b-fb45-4c42-b8b4-359ebda59810` were each `SUCCESS`, ready and the sole
active deployment of their service; both predecessors were removed/stopped.
Workflow checkout/upload evidence and the CLI deployment messages bind the
merge SHA. Railway's provider `commitHash` was null, so it is not a separate
provider Git attestation. Configuration hash remained
`a892fb83e671a35a9b5e4553ea5fcac832905feee5bb3f01ba1a88a543897d2c`;
native source-trigger count remained zero.

Bounded production acceptance on 2026-09-28 passed six checks: worker/web
readiness, web deployment identity, both disabled Gaming MCP boundaries, and
the legacy public bundled canary. The seventh check returned a gameplay
fallback with no usable evidence and failed acceptance. The
[connection record](../../../integrations/arcanos-gaming/connection.requirements.json)
preserves that historical acceptance result, exact reason and counts.
Execution stopped with zero retries and zero durable Gaming writes.

The retained local assessment classifies the Portal request as
`EXPECTED_NO_EVIDENCE`; no repair is warranted by that request. This assessment
includes local mocked characterization and is not new live execution evidence.
The retained Elden Ring supplied-guide attempt remains blocked with
`GAMING_SOURCE_UNAVAILABLE`: the guide was not successfully acquired, and the
underlying acquisition cause remains unresolved. Its HTTP 200 response reported
failure. A catalog entry or retrieval from another source does not establish
successful supplied-guide grounding, currentness or answer generation. The
[current connection assessment](../../../integrations/arcanos-gaming/connection.requirements.json)
keeps these findings separate from the historical Portal acceptance record.
No repeat query or source-acquisition request is needed for composition.

The deployed Gaming resource remains disabled and has no registered Gaming
app. Live OAuth scope/principal mapping, authenticated MCP calls and hybrid
acceptance have not run. Local authorization tests and the successful canary
do not prove those capabilities; the canary skipped provider/network execution.
The backend is deployed, but live Gaming acceptance is incomplete.

## Published configuration evidence

Authenticated read-only Builder and Version History inspection on 2026-09-28
showed **Arcanos Gaming**, **Live / Only me**, and **Current version Sep 19,
2026**. The version detail displays **Sep 19, 2026 at 7:28 PM**. This is a literal
calendar minute; no timezone, seconds or separate revision ID was exposed.
The recommended model shown was GPT-5.6 Sol.

The complete published instructions equal the current editor instructions:
7,996 characters, SHA-256
`44806ae6fa1cc2b250fa4a7a4e214450ddbcfd7d971906202b5240a91a5b9c33`.
This is an instruction-byte hash, **not a complete baseline fingerprint**.
The private local transcription was checked against the observed complete
instruction bytes. Repository text was used only as a transcription aid after
exact hash equality, not as evidence of the saved configuration.

Web Search, Canvas, Image Generation, and Code Interpreter & Data Analysis
were checked in the published version. The editor showed an empty conversation
starter field and no knowledge-file rows; owner review is recorded below.
One Action group was visible. Its settings control did not open, including after
one reload, so its saved schema and stored authentication type needed the
owner-supplied evidence below. No secret was inspected. No GPT update, restore, test message,
sharing change, or migration was performed.

The owner subsequently supplied the complete saved Action schema. Its parsed
JSON exactly matches the repository contract and contains all eight operations;
its schema hash is
`767a6f7dad1a88b5189c03ba297f6e9e6e8ac3635f5a68928a8656ae118c254d`.
The owner then confirmed **API Key**, **zero starters**, and approved the
complete transcription, including its observed empty knowledge inventory.
Stored auth subtype was not inferred: the Action schema separately declares
bearer authentication. The original schema and source text remain private.

**GPT_BASELINE_CAPTURED=VERIFIED**, with owner-reported publication assurance.
Two captures produced identical sanitized inventories. Baseline fingerprint:
`7ecae0312c25c56f1cb66e39ee3de0e56385244632227320d8c2c1bde66b4ac6`.
The [safe baseline inventory](../../../integrations/arcanos-gaming/baseline.inventory.json)
records the complete configuration hash, field hashes and owner approval.
There are zero knowledge files to copy; the future package reference inventory
is still a separate reconciliation gate. Source-derived expected behaviors
remain expectations rather than live execution results.

## Product and authority boundaries

The observed published source corroborates the repository's **hybrid-first**
gameplay workflow. Ordinary gameplay is not forced into Tutor's skill-only
model. [Behavior inventory](behavior-inventory.md) and the
[18-case matrix](behavior-matrix.json) are repository-derived expectations now
supported by the approved source; installed-skill execution is still untested.
Matrix rows are expectations, not test passes.

The [connection contract](../../../integrations/arcanos-gaming/connection.requirements.json)
defines separate query and source-write scopes, one private Gaming app, and
no registered identity yet. Five operations perform reads, evaluation or
transient workflow work; three can queue durable source writes. Read authority
must never grant durable-write authority. Jobs, candidates and workflows retain
actor ownership; source refresh operates on the shared Gaming corpus under the
configured single-owner gate, not fictional per-source tenant ownership.

## Local preparation and owner review

Compose from the approved private baseline without modifying its bytes. The
Gaming adapter reuses the maintained shared composition implementation and
produces one hybrid-first workflow with traceable Action-to-MCP transformations.
All source wording, transformed instructions and reconciliation details stay
under `.local-migration/arcanos-gaming/`. The tracked inventory may record safe
hashes, counts, rule IDs and status summaries only.

```powershell
npm run compose:gaming-skill -- --inputs .local-migration/arcanos-gaming --owner-review owner-baseline-review.json --output composed-skill-v1
npm run compose:gaming-skill -- --inputs .local-migration/arcanos-gaming --owner-review owner-baseline-review.json --output composed-skill-v1 --inspect
```

The private output directory contains `skills/arcanos-gaming/SKILL.md`,
`reconciliation-map.json`, `review-summary.md` and `candidate-manifest.json`.
The manifest records local paths, byte sizes, SHA-256 hashes, approved baseline
fingerprint and tooling revision. Generate twice from unchanged inputs to
compare exact skill bytes and stable content fingerprints. Keep observation
timestamps outside stable content hashes.

The owner checkpoint binds review of the complete local candidate and private
reconciliation report to the exact recorded skill hash. Explicit owner approval
is now recorded separately from technical composition checks, which do not
attest future model behavior or owner approval. Map the existing
18 behavior cases to composed rule identifiers without marking those cases as
passed. A local candidate has no registered app, plugin or release identity and
does not establish an installable connected package.

## Remaining sequence

The current local candidate is `composed-skill-v1/skills/arcanos-gaming/SKILL.md`
under the private input root, **15,210 bytes**, SHA-256
`a2cd3cfb2eb677eaef47c7fc148b41565b58e051486a49b29df48ee53c048081`.
Its sibling `reconciliation-map.json` preserves all 15 source sections:
eight unchanged and seven with explicit integration transformations. The
review summary and candidate manifest are in the same private directory.
The [connection record](../../../integrations/arcanos-gaming/connection.requirements.json)
contains their safe hashes and the composition tooling revision.

Two independent generations produced identical skill, reconciliation, review
and manifest bytes. All 30 retained input/evidence files remained unchanged.
The eight Action names map to the implemented MCP tools; argument shape,
empty canary input, integration availability and consequential-write confirmation
are recorded explicitly. The owner approved the complete new skill at the hash
above, including the proposed wording for `gaming-supplied-source-contract` and
`gaming-client-confirmation`. Supplied-guide acquisition and actual client
confirmation behavior remain unverified.
Local composition and exact-content owner approval are verified.
This does not verify any of the 18 behavior cases or create an app-bound package.

The private approval record is `owner-skill-review-a2cd3cfb.json` under the same
private input root, bound to the skill, all four candidate files, baseline and
tooling hashes. Its safe digest is in the connection record. The original
candidate manifest and review reports retain their generation-time pending
status and unchanged bytes; the separate approval record advances only the
current owner content-review checkpoint. It grants no additional authority.

1. Keep backend query acceptance blocked until separately authorized execution
   verifies it. Do not retry the Elden Ring request, fetch the supplied guide,
   configure OAuth, enable the endpoint or register an app for composition.
2. Obtain separate account/app-registration and migration authorization before
   those activities. Actual Gaming registration is required before validating
   an app-bound package and binding its real artifacts.
3. Complete authenticated MCP acceptance, installed behavior, actual saved
   archive/release reconciliation and separately authorized durable-write
   acceptance under their respective later gates.
4. Obtain final owner merge authorization only after Gaming-specific gates pass.

Main reconciliation with `4db5f9db8c8baa12cb3c26b69dac32a8520b6852` is complete.
The approved baseline remains verified. Hosted CI is a separate code-validation
gate recorded at the migration PR's final head. App registration/connection,
migration, installed behavior and actual archive reconciliation remain pending.
Backend query acceptance remains blocked; OAuth/authenticated MCP acceptance
remains unverified. Account changes, deployments, production durable-write
tests, migration and final merge are outside this composition task. No public
publication or sharing is authorized.
