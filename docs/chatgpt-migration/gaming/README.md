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
records the single remaining `BACKEND_QUERY` blocker, exact reason and counts.
Execution stopped with zero retries and zero durable Gaming writes.

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

## Remaining sequence

1. Resolve the recorded gameplay acceptance blocker; do not repeat the failed
   live request without owner direction. Keep the migration draft and
   release-blocked.
2. Main reconciliation with `4db5f9db8c8baa12cb3c26b69dac32a8520b6852` is
   complete. Hosted CI for the reconciled head is a separate gate recorded on
   the migration PR.
3. The approved baseline fingerprint
   `7ecae0312c25c56f1cb66e39ee3de0e56385244632227320d8c2c1bde66b4ac6`
   was reconfirmed after reconciliation; published capture and owner review
   remain verified.
4. Compose and review the private Gaming skill, validate a package with the
   separately registered Gaming app, and bind its actual artifacts.
5. Obtain separate account/app-registration and **Migrate to plugin** approvals.
6. Reconcile the actual saved private archive and release; run bounded live
   read acceptance, and separately authorized durable-write acceptance.
7. Obtain final owner merge authorization only after Gaming-specific gates pass.

Package composition, app registration/connection, migration and artifact
reconciliation have not happened. Account changes, **Migrate to plugin**,
production durable-write tests and final migration merge remain unauthorized.
The limited live read results above do not complete plugin acceptance. No
public publication or sharing is part of this task.
