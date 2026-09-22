# Tutor package staging

This directory is **release staging, not an installable or registered plugin**.
`plugin.json.template` follows the portable Agent Plugins 1.0.0 manifest schema.
There is deliberately no discoverable `plugin.json`, `.app.json`, `mcp.json`,
marketplace entry, or account identifier. The registered connection is unresolved.

Validate the source from the repository root:

```text
node scripts/validate-tutor-pilot-package.mjs
node scripts/validate-tutor-pilot-package.mjs --release
```

The first command checks the actual manifest schema, skill frontmatter, file
allowlist, symlinks, size bounds, and common credential patterns. It returns the
intended distribution file names and hashes without writing an archive. The second
command must exit 2 (`RELEASE_BLOCKED`) in this PR. It cannot turn an invented ID
or changed metadata into an installable artifact. Secret scanning is a guard, not
proof that arbitrary private material is safe: the exact allowlist and human review
remain required. No private Builder exports or knowledge files belong here.

The vendored schema was fetched from
<https://agent-plugins.org/schemas/1.0.0/plugin.schema.json> on 2026-09-22.
Its UTF-8 bytes, with CRLF normalized to LF for Windows checkout portability, have SHA-256
`0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`.
The validator uses the repository's existing Ajv 2020 implementation, without
network access. The local plugin-creator validator targets the supported older
`.codex-plugin` layout; it does not validate this current portable template.

The only intended distribution contents are root `plugin.json` (materialized from
the template later), the reconciled skill, and a real `.app.json` mapping added in
a separately authorized connection stage. Review metadata, schema snapshots,
regression prompts, exports, credentials, repository source, and development files
must stay outside the eventual archive. The current validator only reports the
manifest and skill candidates; it does not claim the missing app mapping exists.

For development/Codex, the skill can be reviewed here and the assembled backend
tested with the MCP SDK. There is no local marketplace or MCP declaration to
install. A future local development MCP package must be kept separate from the
registered ChatGPT package; remote HTTPS alone does not confer web/mobile support.
See [platform evidence](../../docs/chatgpt-migration/PLATFORM.md) for client limits.

After approved account setup, reconcile the latest published Builder instructions
and private reference inventory outside the public repository, verify the actual
registered app mapping and role access, then add the corresponding OpenAI extension
and dependency metadata using current documentation. Do not merely rename the
template. A follow-up must replace the release blocker with validation of those
reviewed files and test the installed workflow. `regression-prompts.json` contains
the prepared evaluation cases; they are not evidence of ChatGPT behavior.

Source behavior: `src/platform/runtime/tutorPrompts.ts` provides the educator and
direct-answer guidance; `src/core/logic/tutor-logic.ts` provides generic prompt
handling, literal shortcuts, and fallback behavior. The live Builder configuration
and knowledge inventory are unknown. There is no memory or scholarly-search
parity claim for this narrow generic Tutor operation.
