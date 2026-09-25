# Private Tutor inputs and reviewed evidence

This is a local input contract for the repository tools, not an OpenAI export
schema. Preserve actual exports unchanged alongside a reviewed local transcription.
A complete private input now validates deterministically and has owner approval;
GPT_BASELINE_CAPTURED is VERIFIED. Original UI observations are preserved privately; see the [capture checkpoint](TUTOR_BASELINE_CAPTURE_20260925.md). See the [migration handoff](TUTOR_MIGRATION.md)
before collecting data or performing account actions.

## Capture the latest published GPT

Create ignored `.local-migration/arcanos-tutor/published-gpt.json` only from the
owner's actual latest published GPT. Supply every field below; do not fill missing
values from repository source. Empty lists mean the owner confirmed there are none.

| Field | Required local value |
| --- | --- |
| schemaVersion | Number 1 |
| publication | Object with status `published`, actual version label, and publishedAt ISO date/time |
| displayName | Exact published display name |
| description | Complete published description |
| instructions | Complete published Builder instruction text |
| conversationStarters | Array of exact starter strings |
| enabledCapabilities | Array of actual capability names |
| actions | Array of objects with actual `name` and complete non-secret `schema` object |
| sharingStatus | Actual published sharing status |
| representativeBehavior | Nonempty array of expected-behavior descriptions grounded in the old GPT |
| knowledge | Complete array of `name` and relative local `path` for supplied original files |

When supported account evidence exposes only a calendar minute and no timezone,
preserve that literal ISO date/time (for example `2026-03-05T23:54`) without
adding seconds, an offset or `Z`. Record precision and timezone availability in
private provenance and safe evidence notes; do not claim an exact instant. The
existing validator accepts and retains this representation unchanged. These
qualifiers are not extra fields in the sanitized configuration allowlist.

Knowledge paths stay within the input directory. Retain original file bytes;
hashes are byte hashes, so changing line endings changes a file's identity.
Do not put authorization headers, Action credentials or provider keys in schemas.
If safe export/transcription is incomplete, leave the tracked baseline BLOCKED.

From the repository root:

```sh
node scripts/capture-tutor-baseline.mjs --inputs .local-migration/arcanos-tutor --output baseline.inventory.review.json
```

The command creates a new review file without overwriting an existing one. It
does not print private contents. It records only file metadata, hashes,
capability/Action names and field hashes, and marks capture
IMPLEMENTED_NOT_VERIFIED with publication assurance USER_REPORTED. It cannot
independently know that a supplied file represents the latest published account
version. Review names and metadata for privacy before moving the sanitized result
to `integrations/arcanos-tutor/baseline.inventory.json`.

To verify the baseline, record `publicationReview` with `reviewedBy`,
`reviewedAt`, `latestPublishedConfirmed: true` and `evidenceIds` referencing
the actual account/owner evidence. Keep publication assurance distinct from file
hash verification. Update the corresponding gate consistently; the tool never
changes account state or silently advances the tracked ledger.

## Actual migrated artifacts

After separately authorized migration, retain the actual migrated skill,
reference files, portable manifest and warnings locally. Hash each file and record
only `path`, `sha256` and `sizeBytes` in the migration inventory. References
also have `name`. Do not rename, recreate or manufacture a generated artifact
to satisfy the validator. If the in-product metadata format differs from the
currently supported portable format, leave release blocked for explicit inspection
and an evidence-based tooling update.

The local sidecar `migration.inventory.json` records:

- `skill`, `metadata`, `appMapping`, `references`, actual `warnings`, and the
  reviewed `registeredAppId` binding. A verified migration requires all three
  artifact records and the registered app ID. `appMapping` records the actual
  app-mapping file referenced by the migrated manifest, with its path relative to
  the private input directory, SHA-256 and byte size. The manifest's app path is
  resolved relative to that manifest and must select this inspected artifact;
  its single required app must match the registered Tutor connection.
- `accountReview`: reviewer/date, `confirmedMigrated: true` and
  `confirmedWarningsReviewed: true`. These are human review assertions, not
  fields invented inside the actual generated manifest.
- `instructionComparison`: baseline instruction field hash, migrated skill
  hash, final packaged skill hash, reviewer/date, summary and disposition.
  PASS requires the original instruction text to be preserved; intentional
  differences require separate explicit owner acceptance bound to those hashes.
- The migrated skill needs exact-content repository publication approval before
  its private text can be incorporated into the public package.

Every approved reference review records sourcePath, packagePath, SHA-256, byte
size, approvedForRepository true, reviewer and review date. The source and package
inventories must cover the same reviewed files exactly once. Missing, renamed,
changed or additional files remain blocked pending reconciliation. A file that
cannot be published must not be silently dropped to make validation pass.

The initial validator permits UTF-8 reference `.md`, `.txt`, `.json` and
`.csv` files only. Every inspected file is bounded to 1 MiB; the distributable
total is bounded to 4 MiB. Binary/oversized reference publication is deliberately
unsupported until its actual format and scanning policy are reviewed. Baseline
metadata capture can hash supplied binary bytes within the size bound. Do not
convert a file and then claim byte-identical migration.

## Paired parity evidence

Each old/new result records a sanitized summary and its SHA-256 with hashBasis
`sanitized_summary`. This hash identifies the summary, not the full private
conversation. Keep private originals locally and bind each result to the
configuration actually tested. The old result identifies the published
configuration artifact; the new result identifies the actual migrated skill.

The validator also requires complete configuration fingerprints. Its
`baselineFingerprint` helper binds the published configuration and all knowledge
file names, hashes and sizes. Its `packageFingerprint` binds every final package
file path, hash and size, including manifest, app mapping, safeguards and references.
The source-validation JSON reports the latter fingerprint. Re-run affected parity
after changing any of those files; an old passing summary cannot certify new bytes.

VERIFIED parity requires actual paired ChatGPT observations for the specific
prompt and configurations. A user-reported result remains USER_REPORTED, and the
earlier standalone live call cannot substitute for installed migrated-skill
results. Accepted differences need explicit owner acceptance, date and rationale
bound to the prompt and old/new fingerprints, separately from ordinary review.
The complete synthetic fixture in the package tests illustrates the metadata
contract; it is never production or migration evidence.

Each result's `status` and `evidenceIds` identify its observation. A VERIFIED
ChatGPT evidence entry has `parityBinding` with the exact `caseId`, `side`
(`oldGpt` or `plugin`), `promptSha256`, `configurationFingerprint` and
`summarySha256`. Completed activation cases must record `arcanos_tutor`;
non-activation and pre-call clarification cases must record no tool invocation.
Do not copy the earlier standalone call's evidence ID into new paired results.

After all actual evidence has been reconciled, run:

```sh
node scripts/validate-arcanos-tutor-package.mjs --release --inputs .local-migration/arcanos-tutor
```

Only successful artifact inspection derives PACKAGE_READY and RELEASE_READY.
The validator emits a report and file hashes; it does not copy private content,
write an archive, install a plugin, publish, migrate the GPT or retire routes.
The caller must review and record the result before any separately authorized
release. Missing artifacts remain a release block.
