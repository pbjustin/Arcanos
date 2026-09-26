# Tutor skill-first preparation, 2026-09-25

## Scope and before-state

Starting PR #1509 head: `add67d9845639ccbf5d199a0feaf535aec4f6412`.
Main already incorporated: `71672aec22d7babf62d65b96de667f17abd3f219`.
The initial working tree was clean, the private input directory was ignored and
untracked, and GitHub reported OPEN/DRAFT with auto-merge disabled.

Before this change, the tracked skill described tutoring through the authenticated
Tutor tool and contained generic guidance derived from repository runtime prompts.
It did not contain the owner-approved published teaching core. `.app.json` used
`required: true`; release checks required a tool call for ordinary tutoring parity.
The provenance paragraph still said published instructions had not been supplied.
Those were package/migration defects; current-main runtime behavior is unchanged.

## Owner-selected architecture

The teaching skill is the default. Ordinary educational requests, explicit Tutor
selection, a product-name mention, examples, assessment, and formatting requests
must not cause a backend call. The backend app is optional using the supported
`optional: true` representation. The registered app ID, endpoint, OAuth scope,
prompt-only schema, and synchronous non-persistent backend are unchanged.

The current `arcanos_tutor` contract generates a Tutor response and reports public
execution metadata. It offers no documented unique teaching capability requiring
ordinary educational requests to use it. Backend-only execution therefore needs
explicit user intent. An unavailable backend may be followed by clearly labeled
direct tutoring; it must never be represented as a successful backend result.

[Official platform evidence](TUTOR_SKILL_FIRST_PLATFORM_20260925.md) records exact
URLs, access date, optional-field evidence, schema limits, activation behavior,
private packaging, and web/desktop/mobile qualifications. Supported syntax and
local deterministic tests do not establish an installed-client result.

## Private teaching composition

The published baseline remains VERIFIED, fingerprint
`eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25`.
The original private configuration retains SHA-256
`445255487dd270aad087e025b738666340ac1d42a2e45b05fe0b7df640e843bf`.

The public template contains one insertion marker instead of private pedagogy.
The composer validates the captured source and owner-review sidecar, inserts the
exact approved instruction string, and writes a new ignored private package.
Public privacy, activation, optional-backend, and failure rules are separate
sections. The report maps every source section to exact final byte spans and
retains review status. The fifteen-category private teaching checklist distinguishes
located source rules from behavior not established by the published text.

Composition never changes `published-gpt.json`, approves its own output, installs
a plugin, calls a model, or performs Custom GPT migration. The safe
[composition inventory](../../integrations/arcanos-tutor/skill-composition.inventory.json)
records current hashes/counts and subsequent exact-artifact owner approval. The actual review package
lives only under `.local-migration/arcanos-tutor/`; do not upload or commit it.

The owner reviewed and approved the exact composed skill and package fingerprint
at the later approval checkpoint below. TUTOR_SKILL_RECONCILED is now VERIFIED.
This is distinct from baseline approval; a generated candidate is not an actual
migrated artifact.

## Tests and readiness domains

The [teaching matrix](../../integrations/arcanos-tutor/teaching-behavior-matrix.json)
contains eighteen cases covering direct teaching, diagnostics, adaptation, worked
examples, hints, practice and feedback, comprehension, concise/numbered formats,
ambiguity, active-chat follow-ups, memory refusal, explicit backend execution,
truthful backend failure, disconnected ordinary teaching, non-activation, and
cross-plugin boundaries. Source rule IDs refer to private approved sections;
public integration-policy IDs are recorded separately.

The [invocation contract](../../integrations/arcanos-tutor/invocation-policy.json)
is a deterministic reference over supplied semantic facts. It is not a natural
language classifier, a host hook, an enforced permission boundary, or evidence
that a model followed the skill. All actual teaching observations remain
UNEXECUTED. No live backend/provider or paid parity calls occurred.

The [capability matrix](../../integrations/arcanos-tutor/capability-equivalence.json)
tracks Web Search, Canvas, Image Generation, and Code Interpreter & Data Analysis.
All four are NOT_TESTED and, under the owner's subsequent scope clarification,
excluded from Tutor release-equivalence requirements. They are host ChatGPT
features the owner will use externally as needed. Host tools and surface/account restrictions replace no
GPT switch automatically; Canvas equivalence is explicitly unproven. The approved
zero-file knowledge inventory requires no copied source files, but actual migrated
references still require inspection after a separately authorized migration.

The historical sixteen-case parity record remains 0 baseline-bound, 10 provisional,
and 6 unexecuted. Historical observations are unchanged. Future ordinary-teaching
comparisons expect no backend invocation under the new architecture; backend
failure scenarios require explicit intent and controlled evidence. No historical
observation was promoted or made to fit the new contract.

Skill-only readiness requires exact private-skill owner review and teaching
verification independently of backend acceptance. Capability equivalence is
required only when it is in release scope; the current exact four-feature owner
exclusion is separately validated. Backend readiness remains BLOCKED.
Final replacement release still requires actual migrated artifact/reference review,
paired parity, and all existing release safeguards; no migration gate was removed.
The release validator reads private composed bytes instead of requiring private
teaching text in the public package. Credential scanning, path containment,
reference review, exact connection identity, and binding checks remain enforced.

## Checkpoint

Validation and independent reviews are recorded after the combined change is
checked. No deployment, runtime edit, account configuration change, Custom GPT
edit, migration, or PR merge is part of this task. Keep #1509 OPEN/DRAFT, with
auto-merge disabled. The original checkpoint stopped for exact local skill
approval; the subsequent owner approval is recorded below.

## Final local evidence and independent review

Checks completed across 2026-09-25/26 UTC on pinned Node 24.18.1/npm 11.16.0:

- Type-check and build PASS. Lint PASS with zero errors and 76 existing warnings;
  focused ESLint also covers the changed `.mjs` tooling that root lint omits.
- Six focused suites PASS: 247 tests, zero failures/skips. Composition uses synthetic
  private fixtures, and legacy routing tests use mocked services. No live calls.
- Source package/manifest validation PASS. Private v3/v4 composition and inspection
  reproduce the same skill, package and report hashes. Release returns
  RELEASE_BLOCKED, with no archive written.
- Documentation audit: 772 checks PASS. Local links: 573 PASS; 94 external targets
  skipped by the local-only link check. Official sources were fetched separately.
- All four generated indexes regenerated for the three new test files and checked
  current. Sync: zero errors/warnings and five existing informational notices.
- Staged commit guard and whitespace checks PASS. Private-source content scan PASS across all 31 staged files and the working public files; the entire
  private input directory remains ignored and untracked. No runtime, protocol,
  preview, production configuration or workflow bytes changed.

Current private skill: **9,209 bytes**, SHA-256
`7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`.
Private package fingerprint:
`4a5bbb9052929adfac18f57d52090b30a8d62e9b66b1b3e6ecc041ecc5f41958`.
Private report: **14,487 bytes**, SHA-256
`afd229757109e34f54dbf7c8de827ee47194aeb00099adc274a16d93e76c3ba8`.
The safe inventory selects `composed-skill-v3`; v4 supplies matching determinism
proof. Earlier v1/v2 remain historical and are not the owner-review candidate.

Reviewer A independently checked the composer/template and exact source spans.
PED-A-01 identified legacy integration precedence; the successor template resolves
it narrowly and preserves every teaching byte. Final pedagogy integrity review
PASS; behavior and exact owner approval were pending at that checkpoint.
The subsequent owner approval is recorded below; behavior remains unverified.

Reviewer B independently checked integration/privacy/release implementation and
found two evidence-binding gaps. The validator now requires all capability
fingerprints and compares approved source IDs with the inspected private report.
Regression tests pass. Reviewer B separately reviewed the decision helper/matrix
that Reviewer A authored: 1,056 valid semantic contexts passed an exhaustive audit
and 352 inconsistent contexts were rejected. No remaining in-scope blocker.
These are independent reviews of implementation, not live skill acceptance.

The owner review concerns this exact local skill hash and its public integration
changes, including source section `instruction-section-008` being subject to the
new optional-backend/current-chat-only safeguards. It does not authorize migration.
Required hosted checks are evaluated against the final pushed head and recorded
in PR #1509; historical green checks do not certify a later commit.

## Owner scope clarification

Recorded **2026-09-26T00:33:03Z**, evidence
`owner-host-capability-scope-20260926`: Web Search, Canvas, Image Generation,
and Code Interpreter & Data Analysis are outside Tutor's release-equivalence
requirements. They remain available only according to the host's actual
tools/account/surface, and their published baseline settings are unchanged.

The owner decision is bound to the approved baseline and exact four names.
CAPABILITY_EQUIVALENCE_VERIFIED is NOT_APPLICABLE, never VERIFIED by this decision.
Both capability-specific release blockers are removed; every other blocker is
retained. The private skill/package bytes and then-pending exact owner review were
unchanged. No teaching test, capability test, backend call, account change,
migration, merge, or deployment is implied by this scope clarification.

Scope-update validation on Node 24.18.1/npm 11.16.0: package and real private
inspection PASS; release remains RELEASE_BLOCKED (exit 2), with exactly 16
remaining blockers when private inputs are inspected, down from 18. Both removed
codes concern capability equivalence. The report explicitly records
capabilityEquivalenceVerified=false and capabilityScopeExcluded=true.

Four focused suites cover 289 tests, including 54 new scope regressions.
The package suite passed 176 cases on its full run; one inconsistent synthetic
fixture was corrected and its remaining case passed on focused rerun. The other
three suites passed all 112 cases. Type-check/build/lint, focused tooling lint,
774 documentation checks, 575 local link targets, index drift and sync checks
PASS; 76 existing lint warnings and five existing sync notices remain.
Both independent scope reviews PASS: exact owner evidence is required,
NOT_APPLICABLE cannot bypass other gates, actual verification still requires
observations, and private/package/app-mapping bytes remain unchanged.
Final commit checks and hosted results are recorded in PR #1509.

## Owner approval of the composed skill

Owner confirmation recorded **2026-09-26T01:03:47Z**, evidence
`owner-composed-skill-approval-20260926`, approves the previously presented,
unchanged private teaching candidate. The owner confirmation is USER_REPORTED;
`composed-skill-approval-integrity-20260926` separately records repository
inspection of the exact artifacts and approval binding.

- Skill SHA-256: `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`.
- Package fingerprint: `4a5bbb9052929adfac18f57d52090b30a8d62e9b66b1b3e6ecc041ecc5f41958`.
- Baseline fingerprint: `eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25`.
- Private receipt: `owner-composed-skill-review-20260926.json`, retained only
  under the ignored private input directory.
- Receipt SHA-256: `4ddf2236fc129488b44bc18c420b1bd9b7f7d1c639b951e9eb8c837d716200ad`.

The composition inventory is VERIFIED with ownerReview APPROVED, and
TUTOR_SKILL_RECONCILED is VERIFIED. The baseline, skill, package and generation
report bytes did not change. The generation report's PENDING labels describe
creation-time state; this later receipt and the safe inventory record approval
without rewriting historical artifacts.

All eighteen teaching cases remain UNEXECUTED, and historical parity remains
0 baseline-bound / 10 provisional / 6 unexecuted. Teaching readiness and backend
acceptance remain BLOCKED; GPT_MIGRATED remains NOT_STARTED. The host-capability
exclusion remains NOT_APPLICABLE. No installation, migration, merge, deployment,
Custom GPT/account modification, or live/paid Tutor call is authorized by this
artifact approval.

Approval-checkpoint validation: read-only private inspection and package
validation PASS. Release remains RELEASE_BLOCKED (exit 2), with 14 blockers
after private inspection; only the two composed-skill approval blockers were
removed from the prior 16. Ten focused approval/release tests PASS; 167 other
cases were intentionally not selected in that local run. Documentation: 775
checks PASS; local links: 576 PASS, 94 external targets skipped. Indexes remain
current; sync reports zero errors/warnings and five existing notices.
Two independent approval reviews confirm the exact hash bindings, unchanged
private bytes, separate evidence domains, and unchanged behavior/migration
boundaries. No code, tests, template, backend, or account settings changed.
Final staged privacy/commit checks and hosted CI are recorded in PR #1509.
