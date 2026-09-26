# Tutor private optional-app release verification

Evidence date: **2026-09-26 UTC**. Starting PR #1509 head:
`96aaeb2d71f2c9165efda8fdbbc44e7729851775`. The PR remains OPEN, DRAFT,
unmerged, with auto-merge disabled. This record supersedes prior statements
that the current 0.8.2 bytes were unavailable; earlier observations remain historical.

## Existing plugin update

The supported Plugin Creator metadata, source reader, release history and owned
archive retrieval identified the existing private plugin before editing. The
actual current 0.8.2 archive was downloaded, inventoried and compared with the
owner-approved skill. The guarded update used that exact observed release ID.
No plugin, backend app, MCP server, connection or Auth0 client was created.

| Field | Verified value |
| --- | --- |
| Plugin ID | `plugin_d292d1e45ae08191b3911299e30e1a25` |
| Package name | `gpt-e9bcdc399db672af9f66dfd7e18e7953` |
| Previous release | `pluginrel_6ab75ba13ae48191bf8e200a51e1274a` |
| Previous version | `0.8.2+bundle.7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096` |
| Previous release timestamp | `2026-09-26T05:44:01.230201Z` |
| New release and current release | `pluginrel_6ab7f17cb4288191b6a60b25c98d5505` |
| New version | `0.8.3` |
| New release timestamp | `2026-09-26T16:23:24.703906Z` |
| Visibility | PRIVATE, unchanged |
| Installation | Account Manage page shows Uninstall and enabled Use ARCANOS TUTOR |
| Components | One skill, zero references, one optional existing app |
| App ID | `asdk_app_6ab4747769088191856fd8eb02507240` |
| Technical connection ID | `plugin_asdk_app_6ab4747769088191856fd8eb02507240` |
| Resource | `https://acranos-production.up.railway.app/chatgpt/mcp` |
| Tool / expected scope | `arcanos_tutor` / `arcanos:tutor` |
| Connection | Existing Primary reconnected; combined plugin displays Connected |
| Teaching cases / backend invocations in this task | 0 / 0 |

[Private ARCANOS TUTOR](https://chatgpt.com/plugins/plugin_d292d1e45ae08191b3911299e30e1a25)
keeps its original identity and audience. The root and compatibility manifests
change only version and app declaration; all other legitimate 0.8.2 files were
preserved. Creator reordered the compatibility manifest's `apps` key on save,
with identical parsed JSON values. The teaching skill is byte-for-byte unchanged.

## Current supported app mapping

Current [existing-app documentation](https://learn.chatgpt.com/docs/enterprise/plugin-management#reference-an-existing-app-with-appjson)
explicitly requires the underlying app ID without `plugin_`. The
[submission validator reference](https://developers.openai.com/plugins/deploy/submission-errors#mcp-server-reference-errors)
permits `asdk_app_`, `connector_` and `templated_apps_` IDs and boolean `optional`.
The [package guide](https://developers.openai.com/plugins/build/plugins#manifest-fields)
places `apps: "./.app.json"` in `extensions.com.openai`. Its earlier tutorial uses
the technical URL ID loosely; the specific ID reference and validator rules
resolve that ambiguity. The existing account record and successful guarded
Plugin Creator update confirm this app was accepted for this private package.

The saved mapping contains exactly one `arcanos-tutor` entry with the raw app ID
above and `optional: true`, without `required` or duplicate declarations. There
is no bundled MCP server. The live Agent Plugins 1.0.0 schema structurally matched
the pinned schema, SHA-256
`0a4aad95ce337878ad38802ebf0daa3fde76abe3f65400c86bcbb1ec0b3ab883`.
The bundled legacy scaffold validator rejects current `optional` fields and is
not applicable to this portable package; it was not weakened or used to remove
optionality. Current schema checks, strict package checks and Plugin Creator's
successful update/read-back supply the package evidence.

## Actual saved archive inventory

Both archives and raw reports remain ignored under
`.local-migration/arcanos-tutor/optional-app-update-20260926/`. The saved archive
was retrieved through Plugin Creator after the update, independently of the
upload ZIP and rendered UI. Supported source read-back matched the current release. Five text files matched
saved bytes exactly; the skill source view normalized one CRLF to LF (9208
rendered text bytes versus 9209 saved bytes). Only the actual archive establishes
the approved raw skill hash; normalized source text was not used as byte proof.

- Saved archive: `current.tar.gz`, 260242 bytes.
- Archive SHA-256: `1e4d048576157434285da32fc239ed16751f31f6ac6f7c0fe4b7f626b6128732`.
- Complete inventory: 13 members, comprising seven regular files and six directories.
- Saved package fingerprint: `e88b0dc42a9951869b8ff63c999e1b6a02fd08043df96f154012c165c8d99948`.
- Approved and saved skill SHA-256: `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`, 9209 bytes.

The package fingerprint uses the existing deterministic repository convention:
SHA-256 of JSON-encoded regular-file `{path, sha256, sizeBytes}` records sorted
by English path collation. Every directory has zero bytes and SHA-256(empty).
Archive hashes additionally cover serialized container bytes.

| Member | Type | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `.app.json` | file | 129 | `38664c6a5fe355454844ca8b992e5c0b0229b9ab293d655e17a112514f0004f2` |
| `.codex-plugin` | directory | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `.codex-plugin/plugin.json` | file | 1329 | `9c8305e777984396407f3caba8fed42da59f078693a78ce0ba8dd32942abc245` |
| `assets` | directory | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `assets/gpt-icon.png` | file | 253896 | `3a891552d348010ff7b5571d39efd77085db6d5fcecdc0e6641e02dd364c0b06` |
| `plugin.json` | file | 1466 | `ddbff5914801d65f6c5c8ad57fefd7cabf4a0459125b27157645ed0258248cd3` |
| `skills` | directory | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `skills/instructions` | directory | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `skills/instructions/agents` | directory | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `skills/instructions/agents/openai.yaml` | file | 127 | `067d163eb275f2c1ca642972434926560726c5b075abb433bebfc643d50b671d` |
| `skills/instructions/lookup` | directory | 0 | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `skills/instructions/lookup/knowledge-index.json` | file | 18 | `6ac91cab38eae269a4e6457275b3b956f615a7df03de4b1ce88f44b8110efc30` |
| `skills/instructions/SKILL.md` | file | 9209 | `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096` |

The [safe inventory](../../integrations/arcanos-tutor/updated-plugin-release.json)
binds release metadata, archive bytes and every member. The verifier rejects
unexpected files, credentials, duplicates, links, absolute paths, traversal,
nonempty references, additional apps and MCP configuration. Private teaching
content, raw archives and connection credentials are excluded from Git.

## Connection and activation evidence

Before update the existing app page showed Primary selected with an authentication
update warning. Its existing Reconnect action completed; Primary then appeared
without that warning. No Connect another account control was used. After update
the combined plugin displayed Apps 1, Skills 1 and Connected; Manage showed
version 0.8.3 and the teaching skill enabled. App details exposed only the
`arcanos_tutor` catalog entry. This verifies association and availability in the
observed UI, not token renewal durability or successful backend execution.

Approved source instructions continue to route ordinary tutoring directly through
the skill. Plugin selection or the name ARCANOS TUTOR alone is not backend intent.
Only an explicit backend request may use the optional app. No Gaming, Booker,
Core, memory, jobs, admin or operator capability was added. No tutoring prompt,
18-case test or backend invocation was submitted during this task.

## Independent review and gates

Reviewer A independently verified both actual saved archives, candidate/saved
preservation, full inventories, exact approved skill, privacy and current schema:
PASS, no findings. Reviewer B independently read current account metadata/source
and the actual saved archive, reviewed app identity/optionality, unchanged
activation instructions and authority boundaries: PASS, no findings. The lead
separately verified installed/enabled and existing Primary association in the UI.

| Gate | Status |
| --- | --- |
| GPT_MIGRATED | VERIFIED |
| GPT_BASELINE_CAPTURED | VERIFIED |
| TUTOR_SKILL_COMPOSED | VERIFIED |
| TUTOR_SKILL_RECONCILED | VERIFIED |
| BACKEND_APP_REGISTERED | VERIFIED |
| BACKEND_APP_OPTIONALITY_VERIFIED | VERIFIED |
| UPDATED_PLUGIN_ARCHIVE_VERIFIED | VERIFIED |
| TUTOR_SKILL_BEHAVIOR_VERIFIED | BLOCKED |
| LIVE_TUTOR_CALL_VERIFIED | BLOCKED |
| PARITY_VERIFIED | BLOCKED |
| PACKAGE_READY | BLOCKED |
| RELEASE_READY | BLOCKED |

Historical `SKILL_RECONCILED` and `MIGRATED_SKILL_RECONCILED` remain BLOCKED under
the unchanged 0.8.1 native adapter. Their historical comparison is not relabeled
as a current saved-release comparison; the new archive gate records current
byte verification separately. Package and release validation must still fail
closed on behavior, parity, historical reconciliation and backend requirements.

## Validation and next phase

Canonical Node 24.18.1 / npm 11.16.0 validation:

- Package/schema/app mapping, actual archive inventory, skill hash and privacy: PASS.
- Seven focused offline suites, 376 unique tests: PASS (updated archive, package,
  historical native migration, private boundary, skill composition, teaching
  contract and legacy migration). These synthetic tests are not the 18 installed
  teaching cases.
- Type-check and build: PASS.
- Lint: PASS, zero errors and 76 existing warnings.
- Documentation, 588 local links, generated-index check, sync, staged commit guard
  and diff checks: PASS. New test files required the backend index refresh.
- Release validation with actual ignored inputs: `RELEASE_BLOCKED`, exit 2,
  as required; source and saved archive inspection PASS.
- Hosted CI is checked on the pushed PR head; see the PR checks for final status.

Local package validity and saved archive verification do not certify installed
teaching behavior or successful live backend execution.

Next phase: the 18-case installed teaching test with ordinary tutoring producing
zero backend calls; an explicit backend test only under separate authorization;
then migrated parity. PR #1509 is not merged.
