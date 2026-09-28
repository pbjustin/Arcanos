# Tutor current-release reconciliation — 2026-09-27

The current PRIVATE 0.8.5 release can be reconciled without changing the original
0.8.1 migration capture. The new current-release record binds the approved
published baseline, exact approved composition, both separately authorized
insertions, complete saved archive and a fresh installed-cache capture.
It does not advance live backend acceptance or paired parity.

## Artifact identity and preservation

- Plugin: `plugin_d292d1e45ae08191b3911299e30e1a25`.
- Current release: `pluginrel_6ab84427e0d4819182de200f7ce49333`, version `0.8.5`, PRIVATE.
- Approved baseline fingerprint: `eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25`.
- Approved composed skill: `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`.
- Current skill: `282ceeba915a317f6bb3f49eb1929ef5ae9d555781c635b0b8ed7e85977a61b8`, 10,406 bytes.
- Current package fingerprint: `6f945afcce451d822597bc4e79fb1d8b60262416bb75c1eb398a774318d60f5c`.
- Saved archive: `b91898941bc04e953758d4036ae0e944f4229859743d5112b380901942568101`, 260,764 bytes.

Supported Plugin Creator metadata/source inspection rechecked the same current
private release. The installed cache was copied into the ignored
`.local-migration/arcanos-tutor/current-reconciliation-20260926/installed-package/`
at 2026-09-27T01:35:11.007Z. All seven files and six directory members match the
complete saved archive inventory and package fingerprint. All task-created review
copies and captured artifacts remain beneath the ignored private input directory;
the installed platform-managed cache was inspected read-only.

Removing the 660-byte diagnostic insertion recovers the complete 0.8.4 skill.
Removing its 537-byte intake insertion then recovers the approved 9,209-byte
composition exactly. The original baseline's eight instruction sections and
public integration safeguards remain intact. Historical owner approval and the
two subsequent scoped authorizations remain distinct; no new owner approval is
invented. Both manifests describe the same release, with one skill, zero
references and one unchanged optional existing app. No bundled MCP server or
additional backend authority is introduced.

The safe [current reconciliation inventory](../../integrations/arcanos-tutor/current-reconciliation.inventory.json)
selects this reviewed successor. The original `migration.inventory.json` and
its native missing-safeguard comparison remain historical evidence. Source
validation checks exact cross-record bindings. Private release inspection must
also validate baseline/composition bytes, saved archives, both inverse proofs,
and the separate installed capture; metadata alone cannot satisfy that check.

## Teaching, parity and backend remain separate

The existing [installed teaching verification](TUTOR_FINAL_INSTALLED_VERIFICATION_20260926.md)
remains eighteen content passes with nineteen retained response variants and
zero visible ARCANOS backend entries. No teaching case was rerun in this phase.
The seven planned-prompt deviations, host Memory event, unavailable exact model
ID and lack of server-authoritative invocation counts remain explicit. Fresh
cache equality cannot establish which bytes were loaded during earlier turns.

Parity remains **16 total / 0 baseline-bound / 10 provisional-unbound / 6
unexecuted**. All official paired result fields remain empty. The approved
baseline is complete; missing old-side evidence must establish the exact prompt,
response and execution against that published configuration. The missing retained
session/conversation evidence must identify the specific GPT and its published
chat surface, distinguish editor preview, and establish no intervening publication
change. Retrospective binding is allowed when that evidence exists; a fingerprint
need not have been recorded at execution time. Similar current
teaching answers cannot substitute for those records. Twelve parity categories
can be exercised without the backend, but authentication, backend-unavailable,
timeout and cancellation require separately authorized controlled execution.
No failures were manufactured against production and no new backend call was made.

The supported UI inventory exposed no apps or browsers during this recheck.
Current Primary availability is therefore unverified. The earlier generic
Connect-only observation is historical, not a fresh account finding. A supported
authenticated browser session or owner inspection of the existing connection is
needed. No Connect, Continue, Reconnect, metadata Refresh, replacement connection,
Auth0/OAuth change or production change occurred.

`PACKAGE_READY` and `RELEASE_READY` remain BLOCKED by live backend acceptance and
paired parity. The revised-skill parity guard remains fail-closed until a reviewed
current-release parity contract and actual paired evidence exist. Ordinary direct
tutoring remains independent of that optional backend. PR #1509 remains OPEN/DRAFT
with auto-merge disabled; this work does not authorize merging or public sharing.

## Validation and independent review

On Node 24.18.1/npm 11.16.0, 452 existing migration/privacy/guard tests passed
across nine suites, plus all 43 new synthetic reconciliation regressions. The new
cases cover stale bindings, missing or forged approval, altered private bytes,
archive/installation mismatch, case-insensitive path aliases, unexpected
references, changed optionality and missing private inspection. No real private
teaching text is used in those fixtures.

Baseline capture passed twice with identical output/fingerprint. Package
validation, actual private composition/archive/revision/installed inspection,
type-check, build, lint (zero errors, 76 existing warnings), documentation checks,
598 local link targets, reindex check, sync check, staged commit guard, private
boundary and diff checks passed. Release validation returned expected exit 2,
with exactly these remaining blockers:

- `LIVE_TUTOR_CALL_VERIFIED`
- `PARITY_VERIFIED`
- `PARITY_BLOCKERS_REMAIN`
- `CONNECTION_VERIFICATION_INCOMPLETE`
- `LIVE_CHATGPT_EVIDENCE_MISSING`
- `REVISED_SKILL_PARITY_NOT_VERIFIED`

Without `--inputs`, the additional private-inspection blockers remain, including
`CURRENT_RECONCILIATION_BYTES_NOT_INSPECTED`. Two independent reviewers passed
the artifact-preservation and integration/security reviews. The Windows path
alias finding and current/historical documentation wording were corrected.
Final exact-head hosted checks are reported on PR #1509 after push.
