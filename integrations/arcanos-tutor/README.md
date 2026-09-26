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
| ACTUAL MIGRATED PLUGIN ARTIFACT | Not supplied | Only actual output from a separately authorized Custom GPT migration can satisfy migration reconciliation |

The app mapping is `{ "id": "asdk_app_6ab4747769088191856fd8eb02507240", "optional": true }`.
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
Release remains BLOCKED pending installed teaching verification, actual migrated artifacts and
paired parity. Backend acceptance remains independently BLOCKED. A failed backend
must not stop ordinary teaching, and teaching evidence must not certify backend
operation. Synthetic decision tests prove only the reference contract.

## Safe tracked evidence

- `skill-composition.inventory.json`: hashes, counts, source binding, and approved exact-artifact owner review.
- `invocation-policy.json`: explicit-only backend contract; no natural-language classifier or tool executor.
- `teaching-behavior-matrix.json`: eighteen teaching, format, fallback, and boundary cases; actual results remain unexecuted.
- `capability-equivalence.json`: four published capabilities, untested client equivalents, and the baseline-bound owner decision excluding them from Tutor release scope.
- `migration-state.json`: separate teaching, backend, migration, parity, and release gates.
- `baseline.inventory.json`: approved published metadata; original source remains private.
- `connection.requirements.json`: dated account/runtime evidence, including the stopped final bounded backend attempt window.
- `migration.inventory.json` and `reference-review.json`: actual migrated output and exact reference approvals, still missing/empty.
- `parity-matrix.json`: sixteen historical comparison definitions; 0 bound, 10 provisional, 6 unexecuted.
- `schemas/`: unchanged hash-pinned portable schema.

Everything beside `package/` is evidence/tooling, not distributable content.
The public template is also not the private replacement. Keep all private source,
composed output, transcripts, and future migrated artifacts exclusively under
`.local-migration/arcanos-tutor/`, ignored and untracked. Never force-add them.
Zero published knowledge files does not prove the future migrated inventory empty.

Read the [handoff](../../docs/chatgpt-migration/TUTOR_MIGRATION.md),
[private input contract](../../docs/chatgpt-migration/TUTOR_INPUTS.md), and
[skill-first implementation record](../../docs/chatgpt-migration/TUTOR_SKILL_FIRST_20260925.md).
PR #1509 remains draft. The final bounded backend attempt window is closed; no
additional calls, migration, deployment, or merge are authorized.

## Final pre-migration checkpoint

See the [final bounded checkpoint](../../docs/chatgpt-migration/TUTOR_PRE_MIGRATION_CHECKPOINT_20260926.md).
SKILL_PLANE is DEFERRED_POST_MIGRATION: official desktop testing exists but needs
a private cache copy outside this task boundary and unavailable native client
control. No teaching cases ran. BACKEND_PLANE is FAIL: raw A/C/D were unavailable;
ChatGPT A incomplete, C unavailable with ambiguous duplicate activity, D stopped
before the invocation ceiling. READY_FOR_OWNER_DECISION_WITH_BACKEND_DEGRADED
means the owner can decide on migration with an unavailable optional backend; it
does not advance release gates or authorize migration.
