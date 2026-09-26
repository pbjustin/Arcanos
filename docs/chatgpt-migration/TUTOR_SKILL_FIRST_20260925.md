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
records current hashes/counts and pending owner review. The actual review package
lives only under `.local-migration/arcanos-tutor/`; do not upload or commit it.

The owner must review the exact composed skill and package fingerprint before
TUTOR_SKILL_RECONCILED can advance. Baseline approval does not approve the
new composition, and a generated candidate is not an actual migrated artifact.

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
All four are NOT_TESTED. Host tools and surface/account restrictions replace no
GPT switch automatically; Canvas equivalence is explicitly unproven. The approved
zero-file knowledge inventory requires no copied source files, but actual migrated
references still require inspection after a separately authorized migration.

The historical sixteen-case parity record remains 0 baseline-bound, 10 provisional,
and 6 unexecuted. Historical observations are unchanged. Future ordinary-teaching
comparisons expect no backend invocation under the new architecture; backend
failure scenarios require explicit intent and controlled evidence. No historical
observation was promoted or made to fit the new contract.

Skill-only readiness requires owner review, teaching verification, and capability
review independently of backend acceptance. Backend readiness remains BLOCKED.
Final replacement release still requires actual migrated artifact/reference review,
paired parity, and all existing release safeguards; no migration gate was removed.
The release validator reads private composed bytes instead of requiring private
teaching text in the public package. Credential scanning, path containment,
reference review, exact connection identity, and binding checks remain enforced.

## Checkpoint

Validation and independent reviews are recorded after the combined change is
checked. No deployment, runtime edit, account configuration change, Custom GPT
edit, migration, or PR merge is part of this task. Keep #1509 OPEN/DRAFT, with
auto-merge disabled. Stop for approval of the exact local composed-skill hash.

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
PASS; behavior and exact owner approval remain pending.

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
