# ARCANOS TUTOR

ARCANOS TUTOR is now a **skill-first public source template**. Ordinary tutoring
runs through the approved teaching skill directly in ChatGPT. The ARCANOS app
is optional and is used only for explicit backend execution. The current backend
has no documented unique tutoring capability that ordinary teaching requires.

## Three distinct artifacts

| Artifact | Location | Meaning |
| --- | --- | --- |
| PUBLIC TEMPLATE | `package/` | Portable manifest, optional app mapping, and public integration safeguards with one private teaching insertion marker; not teaching-complete or install-ready |
| PRIVATE COMPOSED RELEASE CANDIDATE | Ignored `.local-migration/arcanos-tutor/composed-skill-v3/package/` | Exact approved instruction text composed locally with safeguards; owner approved the exact skill hash, behavior remains unverified |
| ACTUAL MIGRATED PLUGIN ARTIFACT | Ignored `.local-migration/arcanos-tutor/teaching-intake-revision-20260926/saved-0.8.4/`; earlier captures retained privately | Actual saved 0.8.4 archive independently verified with a scoped owner-authorized intake insertion, all historical approved skill bytes preserved, and one optional app |

The public template and composed candidate app mapping is `{ "id": "asdk_app_6ab4747769088191856fd8eb02507240", "optional": true }`.
The endpoint, registered account connection, tool `arcanos_tutor`, and scope
`arcanos:tutor` are unchanged. No authentication or account configuration is
performed by composition. The mapping neither grants access nor filters tools.

The source uses the current OpenAI optional-app representation, separately
validated because the portable schema leaves extension semantics opaque. See
[platform evidence](../../docs/chatgpt-migration/TUTOR_SKILL_FIRST_PLATFORM_20260925.md)
for pinned official sources and supported-surface limitations. Availability on
web, desktop, and mobile is not inferred from manifest validity.

## Local composition and verification

From the repository root, with the approved ignored inputs already present:

```sh
npm run compose:tutor-skill -- --inputs .local-migration/arcanos-tutor --owner-review owner-complete-baseline-review.followup-20260925.json --output composed-skill-v3
npm run compose:tutor-skill -- --inspect --inputs .local-migration/arcanos-tutor --output composed-skill-v3
npm run validate:tutor-package
npm run validate:tutor-release -- --inputs .local-migration/arcanos-tutor
```

Composition exclusively creates a new output directory. Repeating composition
requires another new directory; inspection never rewrites it. Exact source bytes,
section spans, hashes, and private review metadata bind the resulting skill to the
owner-approved baseline. The command cannot approve its own output, install,
migrate, call a provider, write a release archive, or publish private contents.

The owner excludes Web Search, Canvas, Image Generation, and Code Interpreter &
Data Analysis from Tutor release-equivalence requirements and will use host
ChatGPT features externally as needed. These remain enabled in the published
baseline and NOT_TESTED in the evidence ledger; no tool availability or parity
is claimed. Tutor must use only tools actually available in the current session.

The owner approved the unchanged composed skill on 2026-09-26T01:03:47Z.
TUTOR_SKILL_RECONCILED is VERIFIED for that exact private candidate only.
Actual migration and zero-reference reconciliation are VERIFIED. The existing
PRIVATE plugin is now version 0.8.4 with the owner-authorized intake revision and
one optional existing backend app. Actual saved baseline and successor archives
were independently checked byte-for-byte; removing the single insertion recovers
the historical approved skill exactly. Existing Primary association is historical;
the current app UI shows Reconnect required, and no reconnect was performed.
See the [current release and regression record](../../docs/chatgpt-migration/TUTOR_INTAKE_REVISION_20260926.md).
Release remains BLOCKED pending installed teaching verification, migrated parity,
historical native reconciliation and backend acceptance. Seven focused installed
observations produced six content passes and one diagnostic failure. No backend
request was issued; authoritative zero-call evidence remains unavailable.
Synthetic decision tests prove only the reference contract.

## Safe tracked evidence

- `skill-composition.inventory.json`: hashes, counts, source binding, and approved exact-artifact owner review.
- `skill-revision.inventory.json`: separately authorized successor hash, exact insertion, historical source archive, and independent preservation review; does not rewrite composition approval.
- `invocation-policy.json`: explicit-only backend contract; no natural-language classifier or tool executor.
- `teaching-behavior-matrix.json`: historical eighteen-case reference contract; partial installed observations are separately bound in the dated reports and evidence ledger.
- `capability-equivalence.json`: four published capabilities, untested client equivalents, and the baseline-bound owner decision excluding them from Tutor release scope.
- `migration-state.json`: separate teaching, backend, migration, parity, and release gates.
- `baseline.inventory.json`: approved published metadata; original source remains private.
- `connection.requirements.json`: dated account/runtime evidence, including the stopped final bounded backend attempt window.
- `migration.inventory.json` and `reference-review.json`: the initial captured 0.8.1 native bundle and its reviewed empty reference inventory; historical evidence remains unchanged.
- `updated-plugin-release.json`: actual saved 0.8.4 complete archive inventory, revised skill hash, optional app and guarded release identity.
- `parity-matrix.json`: sixteen historical comparison definitions; 0 bound, 10 provisional, 6 unexecuted.
- `schemas/`: unchanged hash-pinned portable schema.

Everything beside `package/` is evidence/tooling, not distributable content.
The public template is also not the private replacement. Keep all private source,
composed output, transcripts, and future migrated artifacts exclusively under
`.local-migration/arcanos-tutor/`, ignored and untracked. Never force-add them.
Both retrieved saved release inventories independently confirm zero references.

Read the [handoff](../../docs/chatgpt-migration/TUTOR_MIGRATION.md),
[private input contract](../../docs/chatgpt-migration/TUTOR_INPUTS.md), and
[skill-first implementation record](../../docs/chatgpt-migration/TUTOR_SKILL_FIRST_20260925.md).
PR #1509 remains draft. The final bounded backend attempt window is closed; no
additional calls, migration, deployment, or merge are authorized.

## Historical pre-migration checkpoint

See the [final bounded checkpoint](../../docs/chatgpt-migration/TUTOR_PRE_MIGRATION_CHECKPOINT_20260926.md).
The following records the earlier checkpoint; migration and the later supported
updates have since occurred. Current teaching status remains BLOCKED after
saved-artifact review and partial installed testing. At the earlier checkpoint,
SKILL_PLANE was DEFERRED_POST_MIGRATION: official desktop testing exists but needs
a private cache copy outside this task boundary and unavailable native client
control. No teaching cases ran. BACKEND_PLANE is FAIL: raw A/C/D were unavailable;
ChatGPT A incomplete, C unavailable with ambiguous duplicate activity, D stopped
before the invocation ceiling. READY_FOR_OWNER_DECISION_WITH_BACKEND_DEGRADED
means the owner can decide on migration with an unavailable optional backend; it
does not advance release gates or authorize migration.
