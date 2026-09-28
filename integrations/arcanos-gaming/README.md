# Arcanos Gaming private migration

This is the second consumer of the migration foundation merged in PR #1509.
It is a private, single-owner Gaming migration. It is paused at the backend
prerequisite, not a distributable plugin or completed account migration.

The published GPT remains unchanged. Raw configuration, instructions, knowledge
files, composition output, and future saved archives belong exclusively in
`.local-migration/arcanos-gaming/`, which is ignored and rejected by the commit
guard. Never put credentials in those files either.

## Current state

- [Migration checkpoint](../../docs/chatgpt-migration/gaming/README.md)
- [Behavior inventory](../../docs/chatgpt-migration/gaming/behavior-inventory.md)
- [Behavior matrix](../../docs/chatgpt-migration/gaming/behavior-matrix.json)
- [Connection requirements](connection.requirements.json)
- [Baseline inventory](baseline.inventory.json)
- [Reuse assessment](../../docs/chatgpt-migration/gaming/foundation-reuse.md)

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

## Package boundary

No app ID or installable package is supplied yet. The future package has one
Gaming skill and one separately registered Gaming backend app. The backend app
is required for evidence-backed Gaming execution; clarify and present results
locally where the approved workflow calls for that. No other plugin app belongs
in the mapping. The approved baseline has zero knowledge files; the expected
reference count is zero, subject to actual migrated-artifact reconciliation.

Composition must bind the owner-approved baseline fingerprint, preserve its
hybrid-first state machine, replace fixed Action names with fixed Gaming MCP
names, and include reviewed integration safeguards. Do not append a second
copy of canonical hybrid instructions. Preserve original source and produce
the composed skill as a separate private artifact for owner review.

The next package phase must validate the portable manifest against the existing
pinned Agent Plugins schema, enforce exact Gaming mapping and approved member
inventory, hash every archive member, and bind the saved release identity.
Tutor's optional-app rule, pedagogy matrix and release validator do not apply.
