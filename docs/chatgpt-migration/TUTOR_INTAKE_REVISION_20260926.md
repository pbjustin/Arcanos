# Tutor intake revision and installed regression — 2026-09-26

The owner approved a minimal correction to the installed teaching omissions:
concrete teaching requests can proceed without confidence/time intake, while
essential clarification and exact output-format constraints retain precedence.
The same PRIVATE ARCANOS TUTOR plugin was updated from 0.8.3 to 0.8.4.

Seven fresh, explicitly selected installed-skill observations produced six
content passes and one diagnostic failure. The earlier explanation, hint, and
worked-example omissions did not recur. The diagnostic response asked two
questions where the unchanged matrix requires one focused question.
**TUTOR_SKILL_BEHAVIOR_VERIFIED remains BLOCKED.**

## Identity, authorization, and byte preservation

- Existing plugin: `plugin_d292d1e45ae08191b3911299e30e1a25`.
- Previous release: `pluginrel_6ab7f17cb4288191b6a60b25c98d5505`, version 0.8.3.
- New/current release: `pluginrel_6ab809c1fea4819182a133da08f4152b`, version 0.8.4.
- Release created: 2026-09-26T18:06:57.994989Z; visibility remains PRIVATE.
- Approved historical skill: 9,209 bytes, SHA-256
  `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`.
- Owner-authorized successor skill: 9,746 bytes, SHA-256
  `02fbc4e2b5a000cf9d49fae9a2d66e1cb59593060cacb6640e5b597202ab3d1d`.
- The single 537-byte insertion starts at byte 558; its SHA-256 is
  `b71e8506daacd6859af46b086bb7f6e90c9962c3a26c2ecd73139968a9dd774d`.
  Removing it reconstructs every historical approved byte exactly. The complete
  successor skill deliberately has a new hash.
- Only other package changes are both manifest versions. All remaining files,
  existing app mapping, presentation metadata, and assets are unchanged.
- Existing app `asdk_app_6ab4747769088191856fd8eb02507240` remains optional with
  boolean `true`; one skill, zero references, one app, no bundled MCP server.

The approval authorizes the described scoped change; it is not represented as an
owner review of an unseen resulting hash. Independent artifact/integration
reviews bind that authorization to the resulting insertion and saved bytes.
Historical baseline, composition, owner hash approval, and 0.8.3 observations
remain unchanged. The strict successor record supplements that history.

Current [OpenAI packaging documentation](https://developers.openai.com/plugins/build/plugins)
continues to place registered app mappings under the root OpenAI extension.
The existing mapping syntax and app identity were preserved.

## Actual saved archive

Both current baseline and successor archives were retrieved through Plugin
Creator. The guarded update used the observed 0.8.3 release ID. Source readback
and actual saved 0.8.4 archive agree; the source reader normalizes a terminal
CRLF, so the archive is authoritative for exact bytes.

- Archive: 260,445 bytes, SHA-256
  `ee75e6ae3488dd625af68c56aecc910454de0ae25b55910e8c97618a09c55ce7`.
- Complete package fingerprint:
  `ac0e3e75de8159fd4788d64fd306f4cb569c48e7a6f63b649132f1dbbc1b9594`.
- Inventory: 13 members, comprising seven files and six directories.
- Paths, TAR checksums/types, complete inventory, extraction equality, credential
  screening, original-byte reconstruction, and private boundaries passed.

| Saved file | Bytes | SHA-256 |
| --- | ---: | --- |
| `.app.json` | 129 | `38664c6a5fe355454844ca8b992e5c0b0229b9ab293d655e17a112514f0004f2` |
| `.codex-plugin/plugin.json` | 1,329 | `5640da06aacc4a42e72926229215dc81db1c50076a5bc7ebd753739d6be67bc1` |
| `assets/gpt-icon.png` | 253,896 | `3a891552d348010ff7b5571d39efd77085db6d5fcecdc0e6641e02dd364c0b06` |
| `plugin.json` | 1,466 | `dfe7c63672922126fc373953056da7e6755de37f58ff9267e0cac39269281e02` |
| `skills/instructions/agents/openai.yaml` | 127 | `067d163eb275f2c1ca642972434926560726c5b075abb433bebfc643d50b671d` |
| `skills/instructions/lookup/knowledge-index.json` | 18 | `6ac91cab38eae269a4e6457275b3b956f615a7df03de4b1ce88f44b8110efc30` |
| `skills/instructions/SKILL.md` | 9,746 | `02fbc4e2b5a000cf9d49fae9a2d66e1cb59593060cacb6640e5b597202ab3d1d` |

The six directory members are `.codex-plugin`, `assets`, `skills`,
`skills/instructions`, `skills/instructions/agents`, and
`skills/instructions/lookup`. Each is zero bytes and has SHA-256
`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
The machine-readable complete inventory is in
[updated-plugin-release.json](../../integrations/arcanos-tutor/updated-plugin-release.json).

## Installed observations

Each case used a fresh ChatGPT web conversation, Chat mode, Medium model-selector
label, and the plugin page's Try in chat control. Matrix prompts were unchanged;
the host added an explicit plugin mention. The exact underlying model ID and
per-turn loaded skill bytes/release IDs are not exposed. Current plugin UI,
account source, and saved archive establish the installed release binding.
Sources showed `arcanos-tutor` for all seven responses.

| Case | Content result | Observation |
| --- | --- | --- |
| DIRECT_EXPLANATION | PASS | Explains the requested equivalent fractions directly |
| GUIDED_HINT | PASS | Useful next-step hint; final solution withheld |
| WORKED_EXAMPLE | PASS | Intermediate fraction conversion, addition, and simplified result |
| PRACTICE_GENERATION | PASS | Exactly two appropriate same-denominator exercises |
| CONCISE_FORMAT | PASS | Exactly two short sentences |
| NUMBERED_FORMAT | PASS | Exactly three numbered steps and no extra prose; screenshot checked |
| DIAGNOSTIC_ASSESSMENT | FAIL | Two distinct diagnostic questions instead of one |

These are seven content observations, not a complete rerun or seven fully
verified cases. Historical uncertain activation, cross-plugin activation,
memory-confounded output, and deferred backend/disconnected-state cases remain
recorded in the [0.8.3 teaching report](TUTOR_INSTALLED_TEACHING_20260926.md).

The current app UI showed **Reconnect required**. Existing registration and
earlier Primary association remain historical evidence; current availability
is not claimed. No reconnection or account change occurred. This observed state
is not relabeled as a controlled fully disconnected test.

No backend invocation was issued by this task or visible in the captured UI.
Authoritative backend call count remains unknown; zero-call verification is not
claimed. No new plugin, app, connection, Auth0 client, scope, credentials,
deployment, or merge was created or performed.

## Evidence, validation, and gates

Private source, both archives, screenshots, raw responses, locators, and reports
remain ignored and untracked under
`.local-migration/arcanos-tutor/teaching-intake-revision-20260926/`.
The private regression ledger inventories 18 raw artifacts, is 17,229 bytes,
and has SHA-256
`1f3eeb0b2dd16b3575b74b08e6e3032f0bd4b89b54e4db46c43fb92c14c9d6c0`.

The successor validator requires separate scoped owner authorization and review,
the historical saved archive, exact insertion and original-byte reconstruction,
unchanged other files, version-only manifest changes, and current saved archive
validation. Missing or conflicting approval fails closed. It cannot promote old
teaching/parity evidence to a revised release.

Independent reviewers verified the actual saved artifact, scoped integration,
and observed content grading. Validation and exact-head hosted CI results are
recorded in the PR update. Release validation is expected to remain BLOCKED.

| Gate | Status |
| --- | --- |
| GPT_MIGRATED | VERIFIED |
| GPT_BASELINE_CAPTURED | VERIFIED |
| TUTOR_SKILL_COMPOSED | VERIFIED (historical composition) |
| TUTOR_SKILL_RECONCILED | VERIFIED (historical approval; successor separately bound) |
| BACKEND_APP_REGISTERED | VERIFIED |
| BACKEND_APP_OPTIONALITY_VERIFIED | VERIFIED |
| UPDATED_PLUGIN_ARCHIVE_VERIFIED | VERIFIED |
| TUTOR_SKILL_BEHAVIOR_VERIFIED | BLOCKED |
| LIVE_TUTOR_CALL_VERIFIED | BLOCKED |
| PARITY_VERIFIED | BLOCKED |
| PACKAGE_READY | BLOCKED |
| RELEASE_READY | BLOCKED |

Next work is owner review of the diagnostic question-count miss, completion of
remaining installed behavior/activation and authoritative zero-call evidence,
separately authorized explicit backend testing, and migrated parity.
PR #1509 remains OPEN/DRAFT, unmerged, with auto-merge disabled.
