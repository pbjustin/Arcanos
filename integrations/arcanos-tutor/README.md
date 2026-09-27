# ARCANOS plugin migration infrastructure — Tutor pilot

Tutor exercised the repository infrastructure for future Custom GPT migrations.
The existing private 0.8.5 artifact is a pilot, not the final Tutor design; the
owner plans to redesign Tutor later, directly as a plugin. PR #1509 now seeks
infrastructure-scope merge review. `MIGRATION_INFRASTRUCTURE_READY` and
`TUTOR_PRODUCT_RELEASE_READY` are separate conclusions: the first may be VERIFIED
while the second remains BLOCKED. This scope decision accepts no Tutor behavior
or parity difference and changes no product-release gate.

Repository merge does not approve Tutor release, update its installed skill,
restore its account connection, or certify its backend. See the
[infrastructure acceptance and reuse handoff](../../docs/chatgpt-migration/TUTOR_MIGRATION.md#infrastructure-acceptance)
for demonstrated mechanisms, evidence limits and retained product follow-ups.

ARCANOS TUTOR is now a **skill-first public source template**. Ordinary tutoring
runs through the approved teaching skill directly in ChatGPT. The ARCANOS app
is optional and is used only for explicit backend execution. The current backend
has no documented unique tutoring capability that ordinary teaching requires.

## Three distinct artifacts

| Artifact | Location | Meaning |
| --- | --- | --- |
| PUBLIC TEMPLATE | `package/` | Portable manifest, optional app mapping, and public integration safeguards with one private teaching insertion marker; not teaching-complete or install-ready |
| PRIVATE COMPOSED RELEASE CANDIDATE | Ignored `.local-migration/arcanos-tutor/composed-skill-v3/package/` | Exact approved instruction text composed locally with safeguards; owner approved the exact skill hash, behavior remains unverified |
| ACTUAL MIGRATED PLUGIN ARTIFACT | Ignored `.local-migration/arcanos-tutor/installed-final-verification-20260926/saved-0.8.5/`; earlier captures retained privately | Actual saved 0.8.5 archive independently verified with two separately authorized narrow insertions, all historical approved skill bytes preserved, and one optional app |

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
PRIVATE plugin is now version 0.8.5 with a narrow diagnostic safeguard and
one optional existing backend app. Removing both authorized insertions in reverse
recovers the historical approved skill exactly. All eighteen actual submitted
installed teaching cases pass content review, with zero visible ARCANOS calls.
Seven planned-prompt deviations and one separate host Memory update are retained;
server-authoritative invocation counts are unavailable. That historical record
does not certify current aggregate teaching readiness. The September 27 exact
comparison found a missing-context follow-up failure and unresolved host-memory
behavior; current teaching readiness is BLOCKED. Supported account UI showed
only generic Connect, with no Primary, Reconnect or Refresh. Existing-connection
restoration and live backend acceptance remain unverified.
See the [latest blocker review](../../docs/chatgpt-migration/TUTOR_BLOCKER_CLOSURE_20260927.md)
and [historical installed verification record](../../docs/chatgpt-migration/TUTOR_FINAL_INSTALLED_VERIFICATION_20260926.md).
Release remains BLOCKED by both parity and backend acceptance. The reviewed
current-release reconciliation preserves the initial native capture as history;
see the [current artifact reconciliation](../../docs/chatgpt-migration/TUTOR_CURRENT_RELEASE_RECONCILIATION_20260927.md).
Reconnect, routing controls and backend A/C/D remain unrun;
no replacement connection or backend request was issued.
Synthetic decision tests prove only the reference contract.

## Safe tracked evidence

- `skill-composition.inventory.json`: hashes, counts, source binding, and approved exact-artifact owner review.
- `skill-revision.inventory.json`: separately authorized successor hash, exact insertion, historical source archive, and independent preservation review; does not rewrite composition approval.
- `diagnostic-revision.inventory.json` and `intake-plugin-release.inventory.json`: strict second revision and preserved 0.8.4 predecessor proof.
- `installed-teaching-verification.json`: retained eighteen-case visible-client verification, exact evidence hashes, plan deviations and observation limits; the later blocked aggregate gate remains authoritative.
- `invocation-policy.json`: explicit-only backend contract; no natural-language classifier or tool executor.
- `teaching-behavior-matrix.json`: historical eighteen-case reference contract; partial installed observations are separately bound in the dated reports and evidence ledger.
- `capability-equivalence.json`: four published capabilities, untested client equivalents, and the baseline-bound owner decision excluding them from Tutor release scope.
- `migration-state.json`: separate teaching, backend, migration, parity, and release gates.
- `baseline.inventory.json`: approved published metadata; original source remains private.
- `connection.requirements.json`: dated account/runtime evidence, including the stopped final bounded backend attempt window.
- `migration.inventory.json` and `reference-review.json`: the initial captured 0.8.1 native bundle and its reviewed empty reference inventory; historical evidence remains unchanged.
- `updated-plugin-release.json`: actual saved 0.8.5 complete archive inventory, revised skill hash, optional app and guarded release identity.
- `current-reconciliation.inventory.json`: exact baseline/composition/revision/archive binding and separate installed-cache capture; clears artifact reconciliation only after private byte inspection.
- `parity-matrix.json`: sixteen comparisons; ten old-GPT observations baseline-bound, zero provisional, six unexecuted; six paired PASS and ten BLOCKER dispositions.
- `schemas/`: unchanged hash-pinned portable schema.

Everything beside `package/` is evidence/tooling, not distributable content.
The public template is also not the private replacement. Keep all private source,
composed output, transcripts, and future migrated artifacts exclusively under
`.local-migration/arcanos-tutor/`, ignored and untracked. Never force-add them.
Both retrieved saved release inventories independently confirm zero references.

Read the [handoff](../../docs/chatgpt-migration/TUTOR_MIGRATION.md),
[private input contract](../../docs/chatgpt-migration/TUTOR_INPUTS.md), and
[skill-first implementation record](../../docs/chatgpt-migration/TUTOR_SKILL_FIRST_20260925.md).
The September 27 product-evidence checkpoint recorded the PR as draft; its
current review state and tested head are recorded on PR #1509. That checkpoint's
production acceptance cycle remains NOT_RUN:
0/6 potential invocations across raw MCP A/C/D and ChatGPT explicit-backend A/C/D,
with zero retries, because the existing Primary association could not be safely
restored in supported UI. That recorded budget does not authorize a new run,
replacement connection, deployment, another plugin update, or merge.

## Historical pre-migration checkpoint

See the [final bounded checkpoint](../../docs/chatgpt-migration/TUTOR_PRE_MIGRATION_CHECKPOINT_20260926.md).
The following records the earlier checkpoint; migration and the later supported
updates and current installed web verification have since occurred. At the earlier checkpoint,
SKILL_PLANE was DEFERRED_POST_MIGRATION: official desktop testing exists but needs
a private cache copy outside this task boundary and unavailable native client
control. No teaching cases ran. BACKEND_PLANE is FAIL: raw A/C/D were unavailable;
ChatGPT A incomplete, C unavailable with ambiguous duplicate activity, D stopped
before the invocation ceiling. READY_FOR_OWNER_DECISION_WITH_BACKEND_DEGRADED
means the owner can decide on migration with an unavailable optional backend; it
does not advance release gates or authorize migration.
