# Arcanos Gaming private migration

This is the second consumer of the migration foundation merged in PR #1509.
This directory records the original private, single-owner migration and supports
local composition from the approved baseline. Its historical connection record
does not configure the installed plugin or report current OAuth, tool discovery,
or gameplay acceptance.

The published GPT remains unchanged. Raw configuration, instructions, knowledge
files, composition output, and future saved archives belong exclusively in
`.local-migration/arcanos-gaming/`, which is ignored and rejected by the commit
guard. Never put credentials in those files either.

## Migration record

- [Migration checkpoint](../../docs/chatgpt-migration/gaming/README.md)
- [Behavior inventory](../../docs/chatgpt-migration/gaming/behavior-inventory.md)
- [Behavior matrix](../../docs/chatgpt-migration/gaming/behavior-matrix.json)
- [Connection requirements](connection.requirements.json)
- [Baseline inventory](baseline.inventory.json)
- [Reuse assessment](../../docs/chatgpt-migration/gaming/foundation-reuse.md)

Backend [PR #1515](https://github.com/pbjustin/Arcanos/pull/1515) merged as
`4db5f9db8c8baa12cb3c26b69dac32a8520b6852` and its maintained production rollout
succeeded worker-first. The bounded read run passed six checks and failed the
legacy gameplay query; the [connection record](connection.requirements.json)
preserves that historical result and exact rollout evidence.
No retry or durable Gaming write occurred. Gaming MCP was disabled during that
run. The retained evidence covers the rollout and its bounded checks.

The connection record's current retained assessment classifies Portal as
`EXPECTED_NO_EVIDENCE`, with no repair warranted for that request. Its local
mocked characterization is not new live telemetry. Elden Ring remains
`GAMING_SOURCE_UNAVAILABLE`; the supplied guide was not acquired and the cause
remains unresolved. HTTP 200, catalog membership or alternative-source retrieval
does not establish supplied-guide grounding, currentness or answer generation.
No new backend request is required or authorized for instruction composition.

## Baseline capture

After the complete published configuration has been captured privately, run:

```powershell
node scripts/capture-gaming-baseline.mjs --inputs .local-migration/arcanos-gaming --output integrations/arcanos-gaming/baseline-candidate.json
```

The wrapper uses the existing capture, fingerprint and credential checks and
the shared private-input boundary. Its sanitized output does not approve the
transcription. Keep the published baseline blocked until the owner reviews the
complete input, including Action schema and stored authentication **type only**.
The complete capture is now owner-approved and passes; missing schema or
authentication-type inputs fail validation. Review any new capture separately.

`public-source-baseline.json` pins pre-existing public canonical instruction
bytes at the inspected main commit. The privacy guard permits only those exact
bytes at that exact existing path. It continues to reject private text copied
to new files, changes at the public path, index-only leaks, and forced staging
of ignored inputs. On a CRLF checkout, restore the reviewed public file's exact
Git bytes locally before this byte-level check; do not weaken the hash check.

## Private composition

With the approved baseline and its owner-review binding present locally:

```powershell
npm run compose:gaming-skill -- --inputs .local-migration/arcanos-gaming --owner-review owner-baseline-review.json --output composed-skill-v2
npm run compose:gaming-skill -- --inputs .local-migration/arcanos-gaming --owner-review owner-baseline-review.json --output composed-skill-v2 --inspect
```

The default composer selects the released `gaming-hybrid-v2` workflow and keeps
explicit v1 only for legacy callers. This does not update the installed private
plugin or approve new private instruction bytes.

The candidate is written beneath `.local-migration/arcanos-gaming/composed-skill-v2/`:
`skills/arcanos-gaming/SKILL.md`, `reconciliation-map.json`, `review-summary.md`
and `candidate-manifest.json`. Preserve baseline bytes and prior evidence.
The full source-to-skill map and review report stay private; tracked metadata
contains only safe hashes, counts, identifiers and status summaries.

Composition requires the verified source and local tooling. It does not require
a successful gameplay answer, live connection, enabled endpoint, app registration
or durable storage. Generate twice from unchanged inputs and inspect hashes and
source binding before owner review. Owner approval of the baseline is not
approval of the new skill: review the complete local skill at its recorded hash.
That approval does not authorize registration, backend changes or migration.

The historical v1 exact-content approval is recorded in `connection.requirements.json`
and the [migration checkpoint](../../docs/chatgpt-migration/gaming/README.md).
The private `owner-skill-review-a2cd3cfb.json` binds that approval to the complete
skill hash. Candidate bytes and generation-time pending review reports are
preserved; content approval does not establish live or installed behavior.

## Semantic assistance candidate

The [proposed skill update](../../docs/gpt/arcanos-gaming-semantic-assistance.instructions.md)
documents the v2 opt-in, the retained grounded workflow, and the release
order. The composer still uses the released baseline.
Compose any new private candidate separately from its approved exact bytes
and review the resulting complete candidate hash before any installation.

## Package boundary

The package pairs one Gaming skill with one separately registered private app.
The app discovers its tool schemas from the Gaming MCP endpoint. Skill content
guides tool use and presentation. After rolling out a contract change, use
**Refresh tools** on the existing app to update that discovered catalog, then
confirm the new fields in a fresh chat. This step preserves the app binding and
OAuth connection. See [OpenAI metadata refresh](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).

Composition must bind the owner-approved baseline fingerprint, preserve its
hybrid-first state machine, replace fixed Action names with fixed Gaming MCP
names, and include reviewed integration safeguards. Do not append a second
copy of canonical hybrid instructions. Preserve original source and produce
the composed skill as a separate private artifact for owner review.

The next package phase must validate the portable manifest against the existing
pinned Agent Plugins schema, enforce exact Gaming mapping and approved member
inventory, hash every archive member, and bind the saved release identity.
Tutor's optional-app rule, pedagogy matrix and release validator do not apply.
Local preparation can succeed with blocked backend acceptance, but must never
produce release success or falsely label an unregistered package ready. Account,
authenticated MCP, installed behavior, actual archive and release evidence stay
pending until their distinct requirements are met.
