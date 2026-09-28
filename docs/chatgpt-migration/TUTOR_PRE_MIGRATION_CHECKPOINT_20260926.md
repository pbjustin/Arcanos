# Tutor final pre-migration checkpoint

Evidence date: **2026-09-26 UTC** (September 25 in the owner's timezone).
Starting PR #1509 head: `892220dcc4a84e5028e7a6c40ade5909f6a4e056`.
Fetched main: `71672aec22d7babf62d65b96de667f17abd3f219`, already incorporated.
The PR remains OPEN/DRAFT, unmerged, with auto-merge disabled.

## Approved artifact integrity

The existing read-only composition inspector passed without rewriting source,
skill, report, or package. The separate exact-artifact owner approval remains valid.

| Binding | SHA-256 / fingerprint |
| --- | --- |
| Approved published baseline | `eb1d612dc2b4645841e3035a177ebb91fa6584a2ae633d7918972b9c9dd95e25` |
| Private source JSON | `445255487dd270aad087e025b738666340ac1d42a2e45b05fe0b7df640e843bf` |
| Approved private skill, 9,209 bytes | `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096` |
| Private package | `4a5bbb9052929adfac18f57d52090b30a8d62e9b66b1b3e6ecc041ecc5f41958` |

Private source, composed artifact, and raw test evidence remain exclusively under
ignored `.local-migration/arcanos-tutor/`. No private teaching text is distributed
by this checkpoint. Host search, Canvas, image generation, and data analysis remain
outside the owner's Tutor release-equivalence scope.

## Real pre-migration execution availability

Official sources accessed **2026-09-26 UTC**:

- [Test the complete plugin](https://developers.openai.com/plugins/deploy/connect-chatgpt#test-the-complete-plugin)
  documents a genuine non-migrating development flow: install the packaged plugin
  from a local marketplace, start a new conversation, and test representative requests.
- [Local marketplace behavior](https://developers.openai.com/plugins/build/plugins#how-local-marketplaces-work)
  says ChatGPT desktop loads a copied installation beneath
  `~/.codex/plugins/cache/.../local/`, rather than executing the source directory.
- [Supported local clients](https://learn.chatgpt.com/docs/enterprise/managed-configuration#restrict-plugin-marketplace-sources)
  names ChatGPT and Codex desktop and Codex CLI. It distinguishes web/mobile from
  these local marketplace operations.
- [MCP server testing](https://developers.openai.com/plugins/deploy/connect-chatgpt#test-an-mcp-server-optional)
  covers developer-mode tools and Playground. It does not execute the private
  teaching skill merely because the backend app is connected.
- [Migration guide](https://learn.chatgpt.com/docs/migrate-custom-gpts#understand-the-change)
  separates skill instructions from service connections and explicitly supports
  optional apps being unavailable without disabling unrelated capabilities.

**SUPPORTED_PRE_MIGRATION_EXECUTION exists on documented desktop development
installations. It is unavailable within this task's current execution and privacy
boundaries.** Enabled browser control exposes authenticated ChatGPT web only;
native desktop control is unavailable. The documented installation also copies
the private skill outside the owner's exclusive local-input directory. No such
copy or installation was performed. No documented equivalent web local-package
preview was found. This is an environment/scope limitation, not a claim that
OpenAI universally requires Custom GPT migration before any skill test.

Accordingly, `TUTOR_SKILL_BEHAVIOR_PRE_MIGRATION=DEFERRED_TO_POST_MIGRATION` and
`TUTOR_SKILL_BEHAVIOR_VERIFIED=DEFERRED_POST_MIGRATION` for this checkpoint.
There is no observed teaching failure, no synthetic substitute, and no installed
skill pass. The deferral remains insufficient for final release.

## Eighteen-case partition

The existing [teaching matrix](../../integrations/arcanos-tutor/teaching-behavior-matrix.json)
remains authoritative and unchanged. Every actualResult/verification remains null.
Partition labels identify what must be exercised, independently of when execution
becomes available.

| Partition | Cases | Count | Current execution |
| --- | --- | --- | --- |
| SKILL_ONLY | DIRECT_EXPLANATION, DIAGNOSTIC_ASSESSMENT, ADAPTIVE_REEXPLANATION, WORKED_EXAMPLE, GUIDED_HINT, PRACTICE_GENERATION, PRACTICE_FEEDBACK, COMPREHENSION_CHECK, CONCISE_FORMAT, NUMBERED_FORMAT, DIFFICULT_OR_AMBIGUOUS_QUESTION, FOLLOW_UP_CONTEXT, MEMORY_REQUEST, UNRELATED_WRITING, CROSS_PLUGIN_BOUNDARY | 15 | Deferred; no requests submitted |
| BACKEND_INTEGRATION | BACKEND_EXPLICIT, BACKEND_UNAVAILABLE | 2 | Deferred for the actual skill; the separate app A/C/D cycle below does not satisfy these skill rows |
| POST_MIGRATION_ONLY in this task | ORDINARY_TUTORING_WITH_APP_DISCONNECTED | 1 | Deferred; requires an isolated installed-plugin unavailable-app state without disconnecting the working account |

The SKILL_ONLY partition contains twelve teaching cases and three non-activation
cases; the latter retain their UNSUPPORTED routing decisions in the matrix.
Teaching totals: **0 executed, 0 passed, 0 failed, 18 deferred**.
SKILL_ONLY backend invocations: **0** because no skill tests ran; this is not
observed proof that an installed skill avoids backend calls. Memory refusal and
unrelated/cross-plugin non-activation still need actual activation evidence.

## Optional backend cycle

The owner authorized exactly one A/C/D raw cycle and one A/C/D ChatGPT cycle, with
no retries. Reconnect and metadata Refresh are readiness operations, not Tutor calls.
The existing Primary account was reconnected through the supported UI before the
first call. Its authentication-update warning cleared; the connected Primary group
was displayed. The existing app's Refresh tools operation completed. App identity
remained `asdk_app_6ab4747769088191856fd8eb02507240`, with OAuth and the expected
production resource. The UI catalog exposed only `arcanos_tutor`; the callable
connector contract exposes its prompt input plus the account-routing link selector.
Public protected-resource metadata confirmed only `arcanos:tutor`. The current UI
did not expose the complete refreshed JSON schema or credential renewal internals;
no new claim of durable token renewal is made.

Read-only Railway metadata at **2026-09-26T01:55:51Z** confirmed current worker
`e08d2468-a287-4d5c-aa1b-f3b8aaf7d0b2` and web
`a994758c-bc6a-4d4e-a8dc-fd4e66cb5f1e`, both SUCCESS with main's revision above.
Provider metadata is not container-byte attestation. No deployment/configuration
change or production repair was performed.

Raw A/C/D each returned `isError=true`, `TUTOR_UNAVAILABLE`, and connector
`error_code=INVALID_ARGUMENT`. Each was attempted once. None supplied an answer,
generation/module/execution/memory metadata, or a successful provider-generation
result. Failure category: **OTHER / backend unavailable**; HTTP status and the
precise internal cause were not exposed. Sentence/step counts, disclaimers,
qualification, and learner-content checks are **not assessable**, not zero/passing.
These failures do not establish a fresh honesty-transform defect or clear the
historical one. No runtime repair was attempted.

A new supported ChatGPT conversation explicitly requested the existing Primary
backend connection and exactly one invocation per submitted case, with no retry.
The permission policy remained Always ask; Allow once was used once for A and
once for C. No ordinary tutoring skill was loaded for these backend tests.

| Case | Raw MCP | ChatGPT backend |
| --- | --- | --- |
| A | Once; TUTOR_UNAVAILABLE / INVALID_ARGUMENT | Once submitted; one visible Tutor activity entry, no visible final result |
| C | Once; TUTOR_UNAVAILABLE / INVALID_ARGUMENT | Once submitted; two visible Tutor activity entries; final error TUTOR_UNAVAILABLE (INVALID_ARGUMENT) |
| D | Once; TUTOR_UNAVAILABLE / INVALID_ARGUMENT | NOT_EXECUTED_BUDGET_CEILING; no prompt submitted |

The two C activity entries may represent separate calls or duplicated UI records.
Actual service-side invocation count and internal ChatGPT retries are unobservable.
Five test requests were submitted in total: three raw and two ChatGPT. Conservative
budget accounting is **six potential invocations (3 + 1 + 2)**, not six confirmed
calls. The attempt window was stopped before ChatGPT D to avoid exceeding the
maximum. The root agent made no retry and requested none; zero hidden ChatGPT
retries is not claimed. No budget remainder or further call authorization is claimed.

Same-invocation raw ChatGPT payloads and actual tool arguments were unavailable
through supported activity/details and conversation-reader surfaces. They were
not reconstructed from the separate raw tests. ChatGPT A is UNVERIFIABLE / no
visible final result; C is OTHER / backend unavailable; D is unexecuted. No
provider-content, formatting, or wrapper-transform conclusion can be drawn from
these unavailable results. Historical formatting failures remain historical.

Private evidence hashes (contents remain ignored):

| Evidence artifact | SHA-256 |
| --- | --- |
| final-acceptance-cycle-20260926.json | `701016965bcd1b9c92375c86a8ac7f7ac497538d69068d760c7d275034c203b8` |
| final-chatgpt-A-20260926.txt | `ccd34b563bfb016fe7614ac788977bc399033009dcfd6842395b6c4ba646ece9` |
| final-chatgpt-C-20260926.txt | `563732f247c5f98751705153cadee9268f838c70c0a1621298e8a2126f8f924f` |
| final-chatgpt-supported-reader-20260926.json | `90f8b102b620e9de29beefa520b246cb700987ac8da1bbfeb8bf65b9289365af` |

Raw prompt identities: A `1889539d24060a7448ed3eb74171dead3e7381ab5121aaef6638d995cba4ef0a`
at 01:57:40Z; C `b2c07437f5fba2109af65016e18b70da578e5cd84d259db3b446385fac6b96aa`
at 01:58:12Z; D `346f6c176ff641bb26b1b86885d73da9c4df49de0fc87589c99ae1cc00fb5db4`
at 01:58:20Z, all on 2026-09-26. Returned execution metadata was absent.

## Owner decision and release boundary

**READY_FOR_OWNER_DECISION_WITH_BACKEND_DEGRADED**.

- **SKILL_PLANE: DEFERRED_POST_MIGRATION**; the exact approved artifact is intact,
  and no actual teaching failure has been observed.
- **BACKEND_PLANE: FAIL / unavailable**; LIVE_TUTOR_CALL_VERIFIED remains BLOCKED.
- No additional pre-migration engineering is required by the evidence. Testing
  on the documented desktop development surface would need a different private
  cache boundary and client access, not a new teaching implementation.

The final checkpoint is a manual evidence decision, not another release gate.
An unavailable optional backend is isolated from the approved direct-teaching
artifact. Current official documentation does not require a healthy optional app
to convert the GPT or use unrelated skill capabilities. Post-migration evidence
is not an extra pre-migration engineering requirement.

Actual migration, migrated-skill/reference reconciliation, paired parity,
PACKAGE_READY, and RELEASE_READY remain unverified/not started. Final release
validation must still fail closed. Baseline approval and private-skill approval
do not authorize the migration click.

## Immediate post-migration checklist — not executed

1. Confirm the actual GPT migration occurred under separate owner authorization.
2. Inspect the actual generated skill and its warnings.
3. Compare it with the exact approved private composed skill above.
4. Inspect the actual reference inventory.
5. Reconcile any unexpected references against the confirmed zero source knowledge files.
6. Verify optional-app behavior in the installed plugin.
7. Execute the existing eighteen-case teaching matrix on the real plugin.
8. Verify ordinary Tutor requests make zero backend calls using available activity evidence.
9. Test explicit backend requests separately under the owner's then-current call authorization.
10. Run migrated-side parity; retain historical unbound observations as unbound unless actual evidence resolves them.
11. Reconcile generated skill/reference differences and record the exact reviewed artifacts.
12. Set PACKAGE_READY / RELEASE_READY only from the actual evidence and passing release validator.
13. Merge #1509 last, under separate authorization.

## Local validation and independent review

Pinned Node 24.18.1 / npm 11.16.0 was used. Read-only private composition
inspection, package validation, type-check, build, lint, documentation audit,
local links, current generated indexes, sync, privacy scan, commit guard, and
whitespace checks passed. Lint retains 76 existing warnings and zero errors;
sync reports zero errors/warnings and five informational notices. No index
regeneration was required. Five focused migration/privacy/composition/teaching
contract suites passed all 296 tests, including four scoped deferral regressions.
These are repository checks, not installed-skill behavior evidence.

Release validation with private inputs returned expected exit 2 / RELEASE_BLOCKED,
fourteen remaining blockers, and archiveWritten=false. The scoped deferral does
not satisfy teaching or release dependencies. No private source or generated
skill bytes changed; package/matrix/runtime bytes remain unchanged by this task.
Hosted CI for the final pushed head is recorded in the PR body, separately from
this local validation record.

Reviewer A passed independent skill/backend separation, private evidence hashes,
and bounded request accounting. Reviewer B passed surface/deferral and release
boundary review. Its maintained-doc finding was fixed: unbound historical parity
does not require new old-GPT executions before presenting the owner decision.
Neither review claims hidden service invocation counts or installed teaching proof.

No migration, GPT edit, replacement install, production credential configuration
or policy change, deployment, or merge is authorized or performed by this report.
The stopped bounded attempt window does not authorize additional backend calls.
