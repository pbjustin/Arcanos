# Gaming migration checkpoint

Arcanos Gaming is a private, single-owner migration. Current main was fetched
and matched `8f31f3eb5c95af1919e5a36e780cfb75e011a7a9`, including PR #1509.
The migration branch is `codex/arcanos-gaming-plugin-migration`.

**Migration is paused at a genuine backend prerequisite.** Main's existing MCP
resource is Tutor-only. Gaming's lower-level services can be reused, but a
separate Gaming OAuth principal adapter and fixed eight-tool MCP resource are
required. The prerequisite is [PR #1515](https://github.com/pbjustin/Arcanos/pull/1515)
on `codex/arcanos-gaming-mcp-auth`, initially validated at
`5524618cae27bcc2676c701816172dd6eaac6455`; it needs
separate owner-authorized merge, deployment and verification before this
migration resumes. Neither PR is authorized to merge automatically.

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

1. Validate and independently review the narrow backend/auth prerequisite,
   including its credential-free sealed exact-head preview and teardown.
2. Obtain owner authorization for the prerequisite merge/deployment; verify it
   independently before reconciling this branch with current main.
3. Reconfirm the approved baseline fingerprint after backend reconciliation;
   the published capture and owner review are complete at this checkpoint.
4. Compose and review the private Gaming skill, validate a package with the
   separately registered Gaming app, and bind its actual artifacts.
5. Obtain separate account/app-registration and **Migrate to plugin** approvals.
6. Reconcile the actual saved private archive and release; run bounded live
   read acceptance, and separately authorized durable-write acceptance.
7. Obtain final owner merge authorization only after Gaming-specific gates pass.

Package composition, registration, migration, artifact reconciliation and live
acceptance have not happened. Sealed preview evidence will not prove OAuth,
production retrieval or durable storage. No public publication or sharing is
part of this task.
