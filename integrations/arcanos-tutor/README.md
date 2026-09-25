# ARCANOS TUTOR

Initial release migration candidate. Package identity and skill are
`arcanos-tutor`; the only tool is `arcanos_tutor`, backed by
`ARCANOS:TUTOR`. The existing registered connection uses
`https://acranos-production.up.railway.app/chatgpt/mcp`.

Only `package/` is a potential distribution root. It contains the current
portable manifest, one required real registered-app mapping, and the
repository-controlled skill. No references have been supplied or approved.
The directory is reviewable source, not an approved replacement installation.

The URL technical ID is `plugin_asdk_app_6ab4747769088191856fd8eb02507240`.
The documented mapping uses underlying ID
`asdk_app_6ab4747769088191856fd8eb02507240`. These are non-secret connection
metadata. A mapping does not register an app or grant account access, and it
does not filter the app's tools: current discovery must still show only Tutor.

The validator pins this observed app ID and endpoint. A future re-registration
requires an explicit reviewed code/evidence update; changing both JSON files
cannot make an unobserved identifier pass as the current connection.

## Validation and evidence

```sh
node scripts/validate-arcanos-tutor-package.mjs
node scripts/validate-arcanos-tutor-package.mjs --release
```

Run these commands from the repository root. Source validation may pass while
release is blocked. Release mode must exit 2 until the actual published baseline,
migrated artifacts, reviewed references and parity evidence satisfy the gates.
The validator does not install, publish, migrate or make a release archive.
Successful synthetic fixture tests prove validator behavior, not live migration.

Keep everything beside `package/` out of distribution:

- `connection.requirements.json`: source-labelled deployment/account evidence.
- `migration-state.json`: thirteen independent gates.
- `baseline.inventory.json`: verified sanitized published-GPT metadata and owner review; raw inputs remain private.
- `migration.inventory.json`: real output inventory; currently not started.
- `reference-review.json`: exact-file publication approval; currently empty.
- `parity-matrix.json`: sixteen public regression definitions and blocked results.
- `schemas/`: hash-pinned official manifest schema for offline validation.

Store private exports, knowledge, migrated output and transcripts only in ignored
`.local-migration/arcanos-tutor/`. Do not paste credentials into any input.
File inclusion in a local inventory is not permission to commit its contents.
Never copy the complete migration-input directory into the package.

Read the [migration handoff](../../docs/chatgpt-migration/TUTOR_MIGRATION.md),
[private input contract](../../docs/chatgpt-migration/TUTOR_INPUTS.md),
[platform reconciliation](../../docs/chatgpt-migration/TUTOR_PLATFORM_RECONCILIATION.md)
and [backend regression review](../../docs/chatgpt-migration/TUTOR_BACKEND_REVIEW.md).
Web MCP execution was observed; the combined migrated skill is not verified.
Mobile is not verified and current custom-MCP guidance is web only.
