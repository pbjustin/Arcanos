# Published Tutor baseline: partial capture on 2026-09-25

**GPT_BASELINE_CAPTURED=BLOCKED.** Supported authenticated read-only inspection
captured partial current-version evidence. No complete `published-gpt.json` was
created, no baseline fingerprint exists, and `latestPublishedConfirmed` remains
**false** for a complete migration baseline. No provisional parity result advanced.

Task starting head: `bba28a75cb54195dd97347100f5120f0b462e80c`; incorporated main:
`71672aec22d7babf62d65b96de667f17abd3f219`. #1509 remains the draft migration
container, auto-merge disabled. Runtime acceptance remains FAIL and
LIVE_TUTOR_CALL_VERIFIED remains BLOCKED independently of baseline collection.

## Authoritative source observations and their limits

The signed-in ChatGPT session opened the existing ARCANOS TUTOR GPT and its
supported Version History. The selected **Current version** is labelled
**Mar 5, 2026**, with detail **Mar 5, 2026 at 11:54 PM**. No timezone, seconds,
machine-readable timestamp or separate revision identifier was exposed in that
view. Those literal labels are preserved; no precise ISO timestamp was invented.
Observation time for the current-version fields: **2026-09-25T16:22:03.991Z**.

| Field | Observed evidence | Limitation |
| --- | --- | --- |
| Display name | ARCANOS TUTOR, disabled current-version field | Full baseline still incomplete |
| Description | Complete disabled field, 268 UTF-8 bytes | Private text retained only locally |
| Instructions | Complete disabled field, 2,333 characters / 2,389 UTF-8 bytes | Private text retained only locally |
| Capabilities | Web Search, Canvas, Image Generation, Code Interpreter & Data Analysis checked in current-version view | No extra capability state invented |
| Recommended model | Current version displays `gpt-5-2` | Editor displays no recommended model; the editor cannot be assumed identical to published state |
| Starters | Editor has one empty input; current-version view omits this section | Published count UNKNOWN, not a confirmed zero |
| Sharing | Editor header says Live / Only me | Current account observation, not a version-history field |
| Actions | One current-version Action, displayed domain `acranos-production.up.railway.app`; complete schema obtained | Actual stored authentication configuration is not exposed by this historical view |
| Knowledge | No original files supplied; version-history view omits the section; editor lists no files | Published inventory/count UNKNOWN, not zero |

The editor separately says **Last edited Sep 24**. Its identity, description and
instruction values exactly match the disabled current-version values, but the
recommended-model difference prevents treating the editor as a complete copy of
published state. No editor changes were made, and no Save, Update, Publish, Share
mutation, Restore or Migrate action was performed. No GPT prompt was submitted.

## Private originals and safe hashes

All raw observations and source bytes are exclusively under ignored
`.local-migration/arcanos-tutor/`. The consolidated private observation file is
explicitly labelled partial and is not the capture script's `published-gpt.json`.
Private instructions, schemas and knowledge contents are not copied here.

| Safe artifact/field | SHA-256 | Bytes / hash basis |
| --- | --- | --- |
| Display name | `38440ecd1ee03d62402fc9f8cf155e86253033d6a3313f9c348b0d883e1e87d0` | 13; exact field UTF-8 |
| Description | `7ee1fe01af75858f311d1769744867bb0992c20a24ef5fd2cd2f4e6de159e950` | 268; exact field UTF-8 |
| Instructions | `53d633ce937a9aef01f2d47749b1127c1accd88b6d4ea95f091c7b11b9909f3f` | 2,389; exact field UTF-8 |
| Original Action schema | `58f8afcf3dae6e711e37c2767290d493d8782910e3295608081d62721d7298ca` | 3,129; original YAML UTF-8 |
| Parsed Action schema | `579d931f35ccb59773fdce51175c667139fe4148cdc26c8362480d68b7bc4e04` | Compact JSON.stringify object, matching capture's schema-hash basis |
| Partial observation file | `26117fb56cb62c181762a9df624fae18f7bc6f08415c076d130460a5ca4d1ec0` | 9,566; exact private file bytes; NOT a baseline fingerprint |

The schema is OpenAPI **3.1.0**, info version **1.0.0**, with one operation:
`POST /ask`, operationId `ask`, at the public production server. It declares
OAuth2 authorization-code security. This declaration is not proof of the stored
Action authentication settings. Both internal references resolve. The displayed
domain, schema title and operation identifier are kept distinct; no new Action
name or authentication value was invented.

The original YAML triggered the maintained credential guard at the multiline
`authorizationCode` flow label. Parsing and serializing the **unchanged schema
object** as JSON passes that same guard. Raw bytes are preserved, parsed equality
was independently checked, and no validator or schema behavior was weakened.
Hashes distinguish original YAML bytes from the parsed schema object.

No supplied published knowledge artifacts exist to hash or compare. Therefore
filename uniqueness, duplicate content and Builder-to-file completeness cannot
be certified. Duplicate UI snapshots are not knowledge files. An empty published
inventory requires explicit owner/account evidence; absence on disk is insufficient.

## Remaining owner inputs and publication checkpoint

Use [TUTOR_INPUTS.md](TUTOR_INPUTS.md) to supply or establish:

1. The authoritative exact publication timestamp with timezone, and version
   identity if exposed. The minute-level label above does not supply missing
   timezone/precision information.
2. Complete published conversation starters, or explicit evidence confirming none.
3. Complete published knowledge inventory and original file bytes, or explicit
   evidence confirming zero published files. Keep canonical filenames and paths.
4. Actual published Action authentication TYPE and relevant non-secret stored
   configuration; no credentials or tokens. The captured schema already supplies
   its declared OAuth2 scheme, server, operation ID and complete definitions.
5. Representative expected behavior reviewed against this published configuration.
6. Explicit confirmation that the complete captured configuration is the latest
   published GPT, together with publication reviewer, review timestamp and evidence
   IDs. Current-version field observations alone do not fill omitted sections.

Only then create the exact private `published-gpt.json`, run capture, inspect its
sanitized inventory and verify the complete baseline. Do not copy repository
prompts into missing fields or use the partial-file hash as the baseline fingerprint.
The capture contract and validators remain unchanged.

## Old-GPT parity review

**TOTAL=16; BASELINE_BOUND=0; PROVISIONAL_UNBOUND=10; UNEXECUTED=6.**
All official oldGpt/plugin fields remain null and all rows remain BLOCKER.
All 16 prompt hashes and 10 available sanitized-summary hashes were rechecked and
match. The corrected private historical observation record is 13,099 bytes,
SHA-256 `eba9b11616e41cf7af4cb7a2fb64830fad72c1a0eca1511b81fd70d7e8b49c5b`.
It explicitly records publishedVersionConfirmed=false and no configuration or
baseline fingerprint. Today's version label does not establish the exact
configuration used for those historical observations. No observation was rewritten
or promoted, and no migrated-plugin evidence was generated.

| Unexecuted case | Missing future evidence / authorization |
| --- | --- |
| unsupported-admin | Actual old-GPT refusal/no-tool result using a controlled nonexecuting account fixture; no real administration |
| auth-failure | Controlled denied/expired-account fixture and actual UI result; do not alter the working connection |
| backend-unavailable | Isolated unavailable-tool fixture and actual UI result; no production outage |
| timeout | Isolated transport/timeout fixture and actual UI result; no paid backend acceptance call |
| cancellation | Controlled cancellation fixture and actual UI result; no production manipulation |
| reference-use | Complete published knowledge inventory plus actual old-GPT reference-use evidence; later N/A requires verified empty published and migrated inventories |

No suitable controlled account fixture exists in the supplied evidence. Offline
fixtures can verify test machinery, not actual old-GPT behavior. No six-case run
or new live ARCANOS/backend/provider call was performed.

## Validation and independent review

Pinned Node **24.18.1** / npm **11.16.0** validation passed: type-check, build,
lint (0 errors / 76 existing warnings), **102 migration/privacy tests in 3 suites**
(0 failures / 0 skips), package validation, docs **756/756** (0 warnings), local
links **557 passed / 84 external skipped**, all four index checks and sync
(0 errors / 0 warnings / 5 information items). Commit guard and Git whitespace
checks passed. No runtime, schema, test or validator source changed.

The maintained capture CLI returned expected **exit 1 / BASELINE_INVALID** with
no output file, because required `published-gpt.json` is absent. Partial evidence
was not substituted for complete input. Release validation returned expected
**exit 2 / RELEASE_BLOCKED**, with **14 blockers** and no archive. Live acceptance
failed; complete baseline, actual migrated artifacts, references and paired parity
remain missing. Validators were not weakened. No live service calls were made.

Independent file/evidence review found no partial-evidence publication blocker.
It confirmed source/version separation, the model difference, missing knowledge
and starter evidence, exact Action schema equality and unchanged conservative
gates. All 11 source artifact hashes and byte sizes matched. This review does not
verify baseline completeness or authorize parity promotion. Hosted CI belongs to
the final pushed head and is recorded in
[PR #1509](https://github.com/pbjustin/Arcanos/pull/1509).

Baseline collection may continue. **Migrate to plugin is NOT authorized.**
Even a verified baseline would not clear the independent live runtime blocker.
