# Tutor actual migrated artifact review

Evidence date: **2026-09-26 UTC**. Starting PR #1509 head:
`69af9d7545408aa1844fe346952a3d3dca390fab`; incorporated main:
`71672aec22d7babf62d65b96de667f17abd3f219`.

Owner-authorized migration completed through the supported account flow at
02:47:17.941Z. The resulting plugin started private and showed installed status.
No sharing, connection change, backend call, deployment or merge occurred during
artifact reconciliation. The original GPT became read-only as a consequence of
migration; no separate deletion or Action retirement was performed.

## Actual output and provenance

Plugin: `plugin_d292d1e45ae08191b3911299e30e1a25`.
Generated package: `gpt-e9bcdc399db672af9f66dfd7e18e7953`.
Version: `0.8.1+bundle.951fdf6546409c5382fa49f2bed2fd2b`.

The browser ZIP export did not deliver bytes during the migration turn. That
partial UI capture is retained unchanged. The subsequently available installed
bundle was copied byte-for-byte into ignored
`.local-migration/arcanos-tutor/installed-artifacts-20260926/`. This is an installed
cache capture, not a claimed ZIP export. All five files retain their original
relative paths. The separate capture receipt is not a package member.

| Artifact | Bytes | Result |
| --- | ---: | --- |
| `.codex-plugin/plugin.json` | 1,327 | Native generated metadata; skills only |
| `skills/instructions/SKILL.md` | 2,531 | Actual generated teaching skill |
| `skills/instructions/agents/openai.yaml` | 127 | Generated skill display metadata |
| `skills/instructions/lookup/knowledge-index.json` | 18 | Explicit empty files array |
| `assets/gpt-icon.png` | 253,896 | Generated presentation asset, not a knowledge file |

Every byte hash is recorded in the safe
[migration inventory](../../integrations/arcanos-tutor/migration.inventory.json).
The full private contents, native metadata and comparison report remain ignored.

| Binding | SHA-256 / fingerprint |
| --- | --- |
| Approved published baseline | `eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25` |
| Approved composed teaching skill | `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096` |
| Actual migrated skill | `5478886612bfe7f80d09bddd0eebb5002644775763efe6aa9046a7c009c8dc5b` |
| Actual installed bundle | `4f4ccff2556b8e8b2560eb16b301647e3edb0d71666dea03feb297b9613745fe` |

## Instruction and reference comparison

The migrated skill body equals the approved published instruction text exactly.
All eight `instruction-section-001` through `instruction-section-008` sections
occur once in order. Published instruction omissions, rewrites and duplications:
**zero**. The platform added skill frontmatter; it did not incorporate the
separately composed integration rules from the repository.

The [safe difference report](../../integrations/arcanos-tutor/migrated-artifact-review.json)
records five material missing integration sections:

1. Privacy, current-chat-only context and precedence over legacy integration rules.
2. Educational activation, non-activation boundaries and exact-format handling.
3. Direct tutoring by default and explicit intent before backend invocation.
4. Truthful failure reporting, separated direct help and no automatic retries.
5. Host capability availability and backend authorization limits.

Generated discovery metadata is generic plugin-invocation guidance rather than
the approved topic-specific activation description. These differences are not
accepted, and approval of the composed skill is not approval of different bytes.
SKILL_RECONCILED and MIGRATED_SKILL_RECONCILED therefore remain BLOCKED.

The complete installed inventory has no knowledge/reference files and its
knowledge index explicitly contains zero entries. This matches the owner-approved
published zero-file inventory. REFERENCES_RECONCILED is VERIFIED for that empty
inventory. Absence of a download alone was never used as zero-file evidence.

## App attachment and teaching execution

There is no generated `.app.json`, MCP server declaration or app attachment.
The supported migration warning said custom Actions do not transfer. The app
attachment is **NOT_ATTACHED**, not a fabricated optional mapping. The existing
separate ARCANOS connection is unchanged and remains degraded/unavailable. The
portable repository candidate's optional mapping is a separate source contract.

Try in chat now opens the supported ChatGPT Work composer with Tutor selected.
No test prompt was submitted. The former pre-migration surface deferral is
historical: current execution is blocked by material integration differences and
the lack of a demonstrated enforced no-backend test boundary for this unreconciled
skill. No model failure, activation result or zero-call teaching pass is inferred.

All **18 teaching cases remain UNEXECUTED**. Fifteen direct teaching and boundary
cases can be considered after reconciliation and safe surface verification.
BACKEND_EXPLICIT needs separate call authorization; BACKEND_UNAVAILABLE needs
actual controlled failure evidence, not an invented transcript. The disconnected
case needs a verified isolated unavailable-app state. Do not disconnect the
working connection to manufacture that condition.

Old-GPT parity remains **16 total / 0 baseline-bound / 10 provisional / 6
unexecuted**. No old observation was promoted and no migrated result was invented.

## Contract and validation

The artifact contract now distinguishes native skills-only migration from the
portable optional-app release candidate. Actual migration occurrence can be
verified while native bytes still require reconciliation. Native capture validates
complete inventory, identity, account/baseline bindings, path containment and
hashes even while release is blocked. Native metadata is not rewritten to imitate
the portable format, and an absent app mapping is not synthesized.

No existing private approval, teaching, parity, connection or release requirement
is removed. PACKAGE_READY and RELEASE_READY remain BLOCKED. Local checks and
independent review are recorded below when complete.

## Official source

Accessed **2026-09-26 UTC**:
[Moving custom GPT workflows to plugins](https://learn.chatgpt.com/docs/migrate-custom-gpts)
documents private migration, skill/reference transfer, non-transfer of custom
Actions, and separate testing of explicit and automatic skill selection. It also
states that a skills-only plugin needs no app connection. These platform facts do
not establish this particular installed skill's behavior.

## Local validation and independent review

Pinned Node **24.18.1** / npm **11.16.0**:

- Type-check and build PASS; lint PASS with 76 existing warnings and zero errors.
- Focused migration/package/privacy/composition/teaching/commit-guard coverage:
  **348 passing tests across six suites**, including 52 new native-capture tests.
  Synthetic fixtures alone are committed. Preliminary fixture setup failures were
  corrected; the final native and portable regression runs pass.
- Actual native artifact inspection and package validation PASS. Source and
  approved private composition hashes remain unchanged. The immutable composition
  report retains its creation-time PENDING labels; later exact-hash owner approval
  remains valid in its separate ledger.
- Release validation returns expected exit 2, RELEASE_BLOCKED, with eleven
  remaining blockers and no archive. No gate was weakened.
- Documentation audit: 783 checks PASS. Local links: 584 PASS. External link
  checks were skipped. Generated indexes were refreshed and reindex:check PASS.
- sync:check PASS: zero errors/warnings and five existing informational notices.
- Private-boundary scan PASS: inputs ignored, no private inputs tracked.
- Scoped lint and git diff --check PASS. Commit guard is required again after staging.

Independent review identified and resolved three validator issues: enforce the
private root before reads; reject unexpected files/dependency metadata rather
than trusting an empty index alone; and explicitly keep native capture blocked
from final release. The final code/test review found no remaining in-scope
blocker. Artifact review separately confirmed that missing safeguards remain a
real installed-skill reconciliation blocker. No actual model test was run.

Hosted checks must apply to the final pushed head. Their result is reported on
PR #1509; local fixtures never substitute for hosted CI or installed behavior.

## Next account checkpoint

Apply the already approved integration behavior to the private migrated plugin
through a supported edit/update flow, preserve the original capture, then
recapture and review the exact updated bytes before testing. This artifact-review
step did not edit or update the installed plugin. Do not accept missing safeguards
merely to clear a gate. Do not request a new migration or another backend call.

## Follow-up: supported private update, 2026-09-26

Evidence recorded at **05:50:16 UTC**, the review/recording time rather than the
exact account save time. The preceding artifact findings and validation results
describe the original captured **0.8.1** bundle. Its missing safeguard sections
remain a historical finding, not the current account-view finding.

The owner authorized updating the existing private migrated plugin with the exact
already-approved `composed-skill-v3` skill. Supported Plugin Creator editing saved
version `0.8.2+bundle.7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`.
The independently inspected account page shows that version; plugin settings show
**Uninstall** and **Use Tutor** checked. The supported skill viewer visibly
contains all five approved safeguard headings. The existing plugin identity is
unchanged; this was an update, not another migration.

Plugin Creator reports an exact skill hash match to
`7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`, PRIVATE visibility,
one skill, zero references and zero attached apps. Those reports and the rendered
Markdown view do **not** independently verify the final saved raw bytes. The
version suffix is also not a computed file checksum from a captured artifact.
Creator also reports six archive members, including a root `plugin.json`; that
archive layout has not been independently inspected.

Both the native browser export and the Creator ZIP download failed to return a
local artifact path. The available local cache still contains 0.8.1. Consequently,
the initial private capture, tracked migration inventory, comparison report and
their original evidence are preserved unchanged. The account update is appended
as `account-plugin-approved-skill-update-ui-20260926` in the
[evidence ledger](../../integrations/arcanos-tutor/connection.requirements.json).

All gate statuses remain unchanged. SKILL_RECONCILED and
MIGRATED_SKILL_RECONCILED remain BLOCKED pending capture and exact review of the
updated bytes. References remain verified only for the initial captured empty
inventory. All eighteen teaching cases remain UNEXECUTED; no teaching result,
backend call, parity result or release approval is inferred. No sharing,
connection change, deployment or merge occurred in this update.

The next step is to obtain a supported export or updated installed-cache capture,
preserve it in a new ignored directory, and verify the complete file inventory,
exact skill hash and baseline/composed-skill bindings before formal testing. The
native adapter remains unchanged and supports only its previously inspected
five-file layout, including a changed skill directory. It has not validated the
reported six-member archive. Do not rewrite generated metadata or weaken release
gates to accommodate an uninspected layout.

Official editing guidance referenced during this supported flow, accessed
**2026-09-26 UTC**: [Build plugins](https://learn.chatgpt.com/docs/build-plugins).
Documentation about the editing flow does not prove this update's artifact bytes
or behavior.

Follow-up validation used the pinned Node/npm toolchain: type-check, build and
lint passed (76 existing warnings, zero errors); 345 focused migration, package,
privacy, composition and teaching-contract tests plus nine commit-guard tests
passed. An initial command named a nonexistent guard-test path; the actual guard
suite was then run successfully. Package validation inspected the approved local
composition and historical captured bundle; it did not inspect uncaptured 0.8.2
bytes. Release validation retained expected exit 2 and eleven blockers. Local
links passed (587 targets); external link network checks were skipped. Documentation,
generated-index checks and workspace synchronization passed. Independent review
confirmed conservative evidence scope, unchanged gates and no private content in
the safe diff. Hosted CI must be checked on the final pushed head.
