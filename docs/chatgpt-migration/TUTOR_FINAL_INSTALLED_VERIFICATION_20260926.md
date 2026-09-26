# Tutor diagnostic correction and installed verification — 2026-09-26

The same PRIVATE ARCANOS TUTOR plugin was updated once, from 0.8.4 to 0.8.5, with a narrow diagnostic safeguard. All eighteen actual submitted teaching cases pass content review, including one focused diagnostic question without alternatives. Complete retained client activity shows zero visible ARCANOS backend invocations. The skill-plane verification is scoped to this installed web matrix; server-authoritative invocation counts and per-turn loaded source bytes are not exposed.

Backend recovery is blocked before execution: the same registered app and production MCP resource are present, but the current supported settings and refreshed detail page do not expose the existing Primary account or Reconnect action. Only a generic Connect flow is available. Its information dialog was inspected and closed before Continue. No connection, app or Auth0 client was created, no OAuth settings changed, no reconnect or metadata Refresh completed, and no backend test was submitted.

## Saved release and preservation

- Plugin: `plugin_d292d1e45ae08191b3911299e30e1a25`; PRIVATE visibility preserved.
- Previous: `pluginrel_6ab809c1fea4819182a133da08f4152b`, 0.8.4.
- Current: `pluginrel_6ab84427e0d4819182de200f7ce49333`, 0.8.5, created 2026-09-26T22:16:07.878392Z.
- Saved skill: 10,406 bytes, SHA-256 `282ceeba915a317f6bb3f49eb1929ef5ae9d555781c635b0b8ed7e85977a61b8`.
- Saved archive: 260,764 bytes, SHA-256 `b91898941bc04e953758d4036ae0e944f4229859743d5112b380901942568101`.
- Complete package fingerprint: `6f945afcce451d822597bc4e79fb1d8b60262416bb75c1eb398a774318d60f5c`.
- One skill, zero references, one optional existing app `asdk_app_6ab4747769088191856fd8eb02507240`. No bundled MCP server.

The one-time 0.8.4 diagnostic reproduction returned one question mark but a three-alternative diagnostic menu. The earlier two-question wording did not recur; the explicit no-stacked-alternatives invariant still failed. Its response-fragment SHA-256 is `2f5658641011c7c17403eaff5985c8cc05db82788b194625fa82b9e443f0c1c0`. Independent review found a narrow instruction gap.

The separately authorized 660-byte insertion begins at byte 1095 and hashes to `0c884555b21935d5d165675b3caa90b87253164bf9142990535b11d0dcf178eb`. Removing it recovers all 0.8.4 bytes (SHA-256 `02fbc4e2b5a000cf9d49fae9a2d66e1cb59593060cacb6640e5b597202ab3d1d`). Removing both authorized insertions in reverse recovers the original approved 9,209 bytes exactly (SHA-256 `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`). Only the two manifest versions changed otherwise. The historical approval is not rewritten or represented as approval of an unseen resulting hash.

The guarded update used the immediately rechecked 0.8.4 release ID. Both baseline and successor archives were retrieved through Plugin Creator; source readback and independent TAR parsing/extraction comparisons agree with the reviewed candidate. The archive is authoritative for bytes, since the source viewer normalizes line endings. The unchanged mapping follows the [current OpenAI package syntax](https://developers.openai.com/plugins/build/plugins).

| Saved file | Bytes | SHA-256 |
| --- | ---: | --- |
| `.app.json` | 129 | `38664c6a5fe355454844ca8b992e5c0b0229b9ab293d655e17a112514f0004f2` |
| `.codex-plugin/plugin.json` | 1329 | `a11350ad038eb68089433675aec931ea227edea0fb08c947f7001c35da3f83b4` |
| `assets/gpt-icon.png` | 253896 | `3a891552d348010ff7b5571d39efd77085db6d5fcecdc0e6641e02dd364c0b06` |
| `plugin.json` | 1466 | `0ca80c12ca34d587bd3f8ffa2d83edd0807880b969057474bd4dc7cef7944843` |
| `skills/instructions/agents/openai.yaml` | 127 | `067d163eb275f2c1ca642972434926560726c5b075abb433bebfc643d50b671d` |
| `skills/instructions/lookup/knowledge-index.json` | 18 | `6ac91cab38eae269a4e6457275b3b956f615a7df03de4b1ce88f44b8110efc30` |
| `skills/instructions/SKILL.md` | 10406 | `282ceeba915a317f6bb3f49eb1929ef5ae9d555781c635b0b8ed7e85977a61b8` |

The six directory members are `.codex-plugin`, `assets`, `skills`, `skills/instructions`, `skills/instructions/agents`, and `skills/instructions/lookup`. Each is zero bytes with SHA-256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`. All thirteen members are inventoried in [updated-plugin-release.json](../../integrations/arcanos-tutor/updated-plugin-release.json). Historical 0.8.4 is preserved in [intake-plugin-release.inventory.json](../../integrations/arcanos-tutor/intake-plugin-release.inventory.json).

## Installed teaching evidence

The current eighteen-case skill-only matrix is separate from the historical reference matrix, which also contains backend and controlled-disconnection cases. Each case was submitted once. Adaptive and follow-up requests reuse their actual retained preceding conversation. Seventeen cases explicitly selected the installed plugin and have positive Tutor Sources; the unrelated-writing case used a fresh unselected chat and has no visible Tutor attribution. Chat mode and the Medium selector were observed; an exact model ID and per-turn loaded release bytes were not exposed.

| Actual case | Content | Sanitized observation |
| --- | --- | --- |
| DIRECT_EXPLANATION | PASS | Explains the requested equivalent fractions through equal scaling of numerator and denominator, with the requested example and no intake delay. |
| DIAGNOSTIC_ASSESSMENT | PASS | Presents one concrete fraction-addition example and asks for one initial step, then stops. No alternate diagnostic menu, additional question, or explanatory lesson is present. |
| ADAPTIVE_REEXPLANATION | PASS | Changes the earlier scaling explanation to a concrete partitioned-whole analogy; retained direct-explanation context is present and no durable profile is claimed. |
| WORKED_EXAMPLE | PASS | Converts to a common denominator, adds the converted fractions, and simplifies the result correctly. No intake delay. |
| GUIDED_HINT | PASS | Provides the useful inverse-operation hint while withholding the final solution. |
| PRACTICE_GENERATION | PASS | One submitted attempt produced two host comparison variants; both retained variants contain exactly two beginner same-denominator addition problems. Duplicated MathML question marks do not create extra tasks. |
| PRACTICE_FEEDBACK | PASS | Identifies the denominator misconception and explains the corrected same-denominator sum without claiming saved progress. |
| COMPREHENSION_CHECK | PASS | One focused multiple-choice comprehension task about equivalent fractions, with an opportunity to respond. The diagnostic-only ban on alternative questions is not extended to this separate comprehension case. |
| CONCISE_FORMAT | PASS | Exactly two short gravity sentences and no extra material, matching the actual submitted teaching prompt rather than the different planned parity prompt. |
| NUMBERED_FORMAT | PASS | Exactly three correct steps simplify the actual requested fraction. Reviewer B independently confirmed visible numbering and no introductory or closing prose; the different planned algebra prompt was not submitted. |
| DIFFICULT_OR_AMBIGUOUS_QUESTION | PASS | Explains that zero divided by zero does not identify a unique quotient and is undefined; does not invent a numeric answer. |
| FOLLOW_UP_CONTEXT | PASS | Uses the retained worked-example context and explains its fraction-conversion step without inventing stored history. |
| MEMORY_REQUEST | PASS | Declines a permanent Tutor learner profile and distinguishes ChatGPT host memory from Tutor capability. No saved-profile claim or routing to another app appears in the assistant response. A separate host Memory updated indicator is present and is retained as a confounding event. |
| UNRELATED_WRITING | PASS | Provides ordinary writing outside a visibly activated Tutor workflow in the fresh unselected conversation. No Sources button or Tutor attribution is exposed; this supports observed non-activation without proving internal runtime inactivity. |
| GAMING_BOUNDARY | PASS | States that Gaming operations are outside Tutor scope without claiming execution or routing to another app. |
| BOOKER_BOUNDARY | PASS | States that booking operations are outside Tutor scope without claiming execution or routing to another app. |
| CORE_ADMIN_BOUNDARY | PASS | Declines Core, administrative, and operator capability without execution claims or alternate-app routing. |
| ORDINARY_TUTORING_WITHOUT_APP_REQUIREMENT | PASS | Teaches equivalent fractions directly without demanding reconnection or claiming backend success. |

The diagnostic response has one focused learner task, one question mark, and no alternative menu or extra follow-up; response-fragment SHA-256 `1f691d47776eda1ab0520fdc2b09fc1fd203f169e4fb552c4a13d255027d14c9`. Hashes of displayed response fragments use the retained DOM representation, not an unavailable raw model payload. Math accessibility text may repeat symbols, so punctuation counts are reported separately from reviewed semantic question counts.

One practice submission produced two client comparison variants; both were retained and passed. Thus eighteen submissions yielded nineteen response variants, without retries or selecting a preferred response. The memory request showed a host ChatGPT Memory updated indicator. The Tutor response correctly declined persistent Tutor storage; the host event is retained as separate activity and is not attributed to the ARCANOS backend. No zero-host-activity claim is made.

Seven proposed parity-aligned prompts in the planning file were not the prompts actually submitted: direct explanation, concise format, numbered format, difficult question, follow-up, memory, and unrelated writing. Both planned and actual hashes are retained with an explicit execution-plan deviation. The actual original teaching prompts still cover the eighteen requested categories. They are not silently relabeled as exact parity executions and were not resubmitted.

The [current installed verification record](../../integrations/arcanos-tutor/installed-teaching-verification.json) binds the actual prompts, response/capture hashes, saved release, review records, deviations, and visible activity. Private source, full responses, screenshots, and archives remain only under the ignored `.local-migration/arcanos-tutor/installed-final-verification-20260926/` directory.

## Connection, controls, and bounded backend budget

Read-only settings confirm the existing raw app ID and `https://acranos-production.up.railway.app/chatgpt/mcp`. Historical Primary association and scope `arcanos:tutor` are retained as historical evidence. Current Primary identity/availability, scope refresh, and live tool discovery cannot be freshly verified without an existing selectable account. Absence of the Primary row is not proof that the historical connection was deleted.

| Check | Current result |
| --- | --- |
| Skill-only routing prerequisite | PASS_VISIBLE_UI: 18 actual cases, zero visible ARCANOS calls |
| Existing Primary reconnect | BLOCKED: Primary row and Reconnect control unavailable |
| Metadata Refresh | NOT_RUN: existing connection unavailable |
| Ordinary routing control | NOT_RUN after the failed connection prerequisite; matrix evidence remains separate |
| Explicit routing control | NOT_RUN: existing connection unavailable |
| Backend A / C / D | NOT_RUN / NOT_RUN / NOT_RUN |
| Execution attempts / authorized ceiling | 0 / 3; no automatic retries |

BACKEND_PLANE is BLOCKED_AUTH_CONNECTION_UNAVAILABLE, rather than a classification of a nonexistent fresh backend response. LIVE_TUTOR_CALL_VERIFIED remains BLOCKED. No backend/runtime code, deployment, OAuth scope, credential, app registration, or connection was changed.

## Parity and gates

Seven existing parity rows now contain related migrated-side teaching progress with actual prompt/result hashes, release/fingerprint bindings, and visible zero-call evidence. Exact prompt mismatches are explicit. All official oldGpt/plugin paired-result fields remain unchanged and null, and all sixteen rows remain BLOCKER. Ordinary teaching expectations use skill-only behavior; backend-specific cases remain backend-specific. PARITY_VERIFIED is BLOCKED.

| Gate / plane | Status | Evidence scope |
| --- | --- | --- |
| TUTOR_SKILL_BEHAVIOR_VERIFIED | VERIFIED | Eighteen actual installed web cases and complete retained visible activity; explicit limitations retained |
| SKILL_PLANE | PASS_VISIBLE_UI | Content and routing within this matrix; host memory activity disclosed |
| UPDATED_PLUGIN_ARCHIVE_VERIFIED | VERIFIED | Actual saved 0.8.5 archive and both exact insertion proofs |
| BACKEND_APP_OPTIONALITY_VERIFIED | VERIFIED | Exactly one unchanged optional existing app |
| LIVE_TUTOR_CALL_VERIFIED | BLOCKED | Connection prerequisite unavailable; no fresh execution |
| BACKEND_PLANE | BLOCKED_AUTH_CONNECTION_UNAVAILABLE | No existing Primary reconnect control available |
| PARITY_VERIFIED | BLOCKED | Exact paired comparison contract not satisfied |
| PACKAGE_READY / RELEASE_READY | BLOCKED / BLOCKED | Backend acceptance, paired parity and historical native reconciliation remain unresolved |

## Validation and independent review

The final focused regression run passed 446 tests across nine suites. Actual private package, archive inventory, composition/hash, app mapping, teaching/routing evidence, migration and privacy validation passed. Type-check, build, lint (zero errors; 76 existing warnings), docs:check, 592 local link targets, reindex:check, sync:check, and diff checks passed. Release validation exited 2 with the expected BLOCKED result. Commit guards and exact-head hosted results are recorded with the published PR evidence.

Deterministic tests prove contract and byte preservation, not generated model behavior. Current-release teaching verification uses separate retained installed evidence; both reviewers independently checked all sixty bound evidence artifacts. Pre-update checks also passed before the guarded update.

Reviewer A independently verified the actual saved archive, all members, both byte-preserving insertions, and all eighteen actual teaching cases. Reviewer B independently verified complete visible routing, exact attempt counts, optionality, unchanged authority, plan deviations, and the separate host memory event. Neither reviewer made an account mutation or backend call.

The remaining work is access to the existing Primary connection, followed by the once-only routing controls and bounded backend acceptance under the owner’s scope, then exact migrated parity. This evidence does not establish a need for backend engineering. PR #1509 remains OPEN/DRAFT/unmerged with auto-merge disabled. No merge or deployment occurred.
