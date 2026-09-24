# Tutor runtime acceptance after PR #1510

Evidence date: **2026-09-24 UTC**. **RUNTIME_ACCEPTANCE=FAIL**.
**LIVE_TUTOR_CALL_VERIFIED=BLOCKED**. Authentication, current schema and real model
execution were observed, but repeated raw honesty/format failures remain.
**MIGRATION_CHECKPOINT_READY=false**. No migration gate is promoted by this report.

## Revision and production verification

- [PR #1510](https://github.com/pbjustin/Arcanos/pull/1510) is merged. Approved head:
  `3bf9edc010f8e1680783d6fcd19ba990d88894ad`.
- Merge and fetched current main: `8af7a5712ebd5954a97af06ab31d0e2527ac0b58`.
- Production project: `7faf44e5-519c-4e73-8d7a-da9f389e6187`;
  environment: `fb583147-6c39-4343-9267-500f357d25ab`.
- Worker: `628f094e-4fee-4523-8eb0-2dc145364e96`.
- Web: `4d3576b6-8f45-421e-ba6d-23b9f01f079d`.

The fresh read-only gate completed at **17:51:14.305Z**: both expected deployments
were sole active/latest `SUCCESS` and ready; worker accepted claims. Web dependency
readiness reported healthy database/schema, Redis, provider initialization/circuit,
admission and startup state. This is cached runtime readiness, not a new SQL or
provider probe. Settings, variable fingerprints, visible staged metadata and native
trigger count were unchanged. No deployment, rollback, credential or configuration
change occurred in this acceptance task.

Source identity is supported by the previously verified exact Git-blob uploads,
receipts and unchanged active deployment/image identities. Railway CLI uploads
do not provide an independent in-container Git attestation. This limit is
preserved rather than described as direct container SHA proof.

Public protected-resource metadata returned HTTP 200 and the exact production
resource `https://acranos-production.up.railway.app/chatgpt/mcp`, with only
`arcanos:tutor`. Anonymous MCP returned HTTP 401 /
`CHATGPT_AUTHORIZATION_REQUIRED`. No extra tool capability appeared in the
subsequent authenticated account catalog.

## Existing connection recovery and refresh

The existing **Primary** account was selected in ChatGPT plugin settings.
Supported **Reconnect** completed with **Primary is now connected**. No owner
credential entry was needed for that existing session. Registered identity
`asdk_app_6ab4747769088191856fd8eb02507240` and technical identity
`plugin_asdk_app_6ab4747769088191856fd8eb02507240` were preserved.

Before reauthentication the UI showed the old pattern and no Refresh control.
After reauthentication **Refresh** appeared under Information. Clicking it
reported **Tools refreshed** and changed the advertised pattern to the corrected
one below. Reauthentication alone did not refresh the schema. This used the
[current official metadata-refresh flow](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata).
No connection was disconnected, replaced, newly registered or repointed.

Exactly one tool was advertised: `arcanos_tutor`, OAuth scope `arcanos:tutor`.
No Gaming, Booker, Core, operator, memory, jobs, DAG, admin or generic module tool
was exposed. The observed schema matches current main:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "arcanos-tutor.input.v1",
  "type": "object",
  "additionalProperties": false,
  "required": ["prompt"],
  "properties": {
    "prompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 8000,
      "pattern": "^[\\s\\S]*\\S[\\s\\S]*$"
    }
  }
}
```

Canonical schema SHA-256, recursively sorted object keys, compact UTF-8 JSON:
`436ed5cc926e0aafc1db6cf40657ae0b0ef3e996f063310a84555e2ef2eef148`.
The raw B call with an actual LF succeeded. Invalid boundaries remain covered
by offline production-handler tests; no invalid live provider probes were added.

## Expired-connection diagnosis

**Cause H: UNKNOWN; G: connection/account-state symptom observed.** The existing
Primary reconnect and four subsequent authenticated raw generations prove recovery.
They do not prove which earlier credential/session expired or whether long-term
renewal works. A second pre-existing account remained unauthenticated and untouched.
ChatGPT A returned UNAUTHORIZED without exposing its selected account binding;
do not infer that it used either account. B-D explicitly requested Primary.

At **17:57:08Z**, anonymous current Auth0
[OIDC discovery](https://dev-etfsljoipfurdij6.us.auth0.com/.well-known/openid-configuration)
and
[OAuth authorization-server metadata](https://dev-etfsljoipfurdij6.us.auth0.com/.well-known/oauth-authorization-server)
returned 200, the exact issuer, `offline_access`, `authorization_code`,
`refresh_token` and S256. Missing issuer-level refresh advertisement is ruled out.

The Auth0 Dashboard reached its secure owner sign-in checkpoint; exact application
and API policies could not be read without owner sign-in. The official Auth0 CLI
was unavailable. Therefore A (ordinary session expiry), B (issuance/invalid renewal),
C (actual requested offline scope), D (rotation/lifetime), E (callback/client) and
F (issued resource/audience) remain unproven causes. Successful reconnect shows the
current supported flow can complete, not what failed historically.

Current OpenAI [OAuth guidance](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
and [authentication contract](https://developers.openai.com/plugins/build/auth)
distinguish server discovery from a usable account grant. Auth0 additionally
requires the existing client Refresh Token grant and API Allow Offline Access,
plus the requested scope; see
[refresh issuance](https://auth0.com/docs/secure/tokens/refresh-tokens/get-refresh-tokens)
and [expiration policy](https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-expiration).
The resource scope `arcanos:tutor` alone does not show whether OAuth requested
`offline_access`.

Durable refresh-path problem: **NOT_VERIFIED**, neither confirmed nor ruled out.
This is an unresolved reliability check, not grounds for changing Auth0 policy.
Runtime acceptance is already blocked by independently observed raw backend defects.
No tokens, secrets, cookies, credential stores or session databases were inspected.

## Bounded raw MCP acceptance

The four raw calls used the existing authenticated Primary connected-tool interface,
`arcanos_tutor`, against the production revision above. Each was attempted exactly
once after reauthentication and explicit Refresh. Every result had `isError=false`
and metadata `module=ARCANOS:TUTOR`, `generation=model`,
`execution=synchronous`, `memory=unavailable`. The connector did not expose the
HTTP status; success here is the structured MCP/tool result. There were no mock,
shortcut, schema, auth, timeout or provider-unavailable results in these four calls.

| Case | Exact prepared prompt | Raw outcome | Count and disposition |
| --- | --- | --- | --- |
| A | Explain why one half equals two quarters, in two short sentences. | FAIL: BACKEND_RAW_FORMAT | Three sentences, including irrelevant live-access disclaimer; equality explanation correct. |
| B | Explain why 1/2 equals 2/4.\nUse exactly two short sentences and no heading. | PASS | Actual LF submitted; two sentences, no heading/disclaimer, correct equality explanation. |
| C | In exactly two sentences, explain why 1/2 equals 2/4 and ask the learner to check the equality by cross-multiplying. | FAIL: BACKEND_CONTENT and BACKEND_RAW_FORMAT | Two sentences, but one is the irrelevant disclaimer; requested learner check absent. |
| D | Give exactly three numbered steps to solve 2x + 3 = 9, with no introduction. | FAIL: BACKEND_RAW_FORMAT | Correct x=3; three inline numbered markers, zero separate numbered lines, preceded by irrelevant disclaimer. |

B's displayed `\n` above denotes the actual LF in the submitted prompt.
**Raw totals: 1 pass, 3 failures, 0 skipped; 4 real model results.**
Exact public math answers are preserved privately with timestamps and hashes.
No answer was edited, truncated, retried or passed through a corrective rewrite.

## ChatGPT acceptance, kept separate

A new supported ChatGPT Work conversation was opened from the existing plugin
after Refresh. A-D were each submitted once with instructions to call Tutor once
and not retry. B-D additionally named the existing Primary account. The exact
prepared text was preserved inside that routing envelope. B's actual LF was
verified in the composer and submitted user message.

| Case | Displayed outcome | Same-invocation raw result |
| --- | --- | --- |
| A | AUTH: UNAUTHORIZED / expired-connection card. No Tutor answer. The reconnect card was declined to avoid retrying A. | Not exposed; selected account unknown. |
| B | Display-only PASS: two sentences, no heading or disclaimer, correct explanation. | Unavailable; no independent raw metadata or tool-argument newline verification. |
| C | FAIL: displayed disclaimer and equality explanation, omitted learner check, added introduction/commentary; four sentences overall. | Unavailable; OTHER (display failure, backend-versus-presentation attribution unverified). |
| D | FAIL: introduction, disclaimer and three inline markers, followed by commentary; no-introduction/step-layout requirement violated. | Unavailable; OTHER (display failure, origin unverified). |

The expanded activity entries and supported thread reader exposed user messages,
tool-activity summaries and final responses, but not raw tool payloads or exact
tool arguments. C/D final responses quoted purported tool answers; those quotations
are **not independently captured raw payloads**. They cannot establish
`CHATGPT_PRESENTATION` causality. Separate raw calls are not substituted for
the missing same-invocation evidence.

**ChatGPT display totals: 1 pass, 3 failures (1 auth, 2 format/content), 0 skipped.
Fully evidenced raw/final paired ChatGPT passes: 0/4.**
Four raw calls plus four ChatGPT submissions exhausted all eight authorized slots.
Actual backend execution is independently verified for the four raw calls only;
UI trace establishes the ChatGPT attempts but not exact backend invocation counts.
No further Tutor call or automatic retry is authorized by this run.

## Specific remaining defect and independent read-only analysis

A/C/D prove a backend output failure independently of ChatGPT's final presentation.
A separate reviewer traced the exact canned disclaimer to
[trinityHonesty.ts](../../src/core/logic/trinityHonesty.ts) and direct-path insertion
in [trinity.ts](../../src/core/logic/trinity.ts). Source review shows the server-owned
Tutor policy is forwarded to both honesty passes. Offline calls to the actual pure
honesty functions at main8af7, with the existing direct-path caveat injection
mirrored locally, reproduced:

- Valid learner questions such as a cross-multiplication request beginning
  "Can you check", a question-mark variant, and an ordinary substitution check
  are classified as live verification by the narrow prefix/character/vocabulary
  allowlist.
- Once a disclaimer is inserted, limitation normalization joins segments with
  spaces and can flatten an otherwise valid numbered list.

Constructed candidate pre-guard strings reproduced the observed raw C and D outputs
byte-for-byte. These constructed strings were **not captured provider outputs**,
so precise causality for the live generations remains a hypothesis. The deterministic
allowlist/format interaction is a specific follow-up repair candidate, not a reason
to loosen generic honesty or authentication or add broad output rewriting.
No backend or test implementation was changed in this task.

## Reconciliation and validation

Current main was merged non-destructively into #1509 from prior head
`55eeb0dc597acde29b541b25916cc2a1a744be22`. Only the four generated indexes
conflicted; existing tooling regenerated them. All nine runtime/schema/test repair
files plus `docs/SCHEMA_PROTOCOL_GUIDE.md` match main exactly and are absent from
the remaining PR diff. Migration package/tooling, blocked gates, private ignored
inputs and unrelated worktrees were preserved. No rebase or force-push.

Fresh pinned Node24.18.1/npm11.16.0 type-check/build passed. Lint passed with
0 errors and 76 existing warnings. Twelve focused suites passed 320 tests, and
the separate Tutor package suite passed 90 tests: **410 passed across 13
nonoverlapping suites, 0 failed, 0 skipped**. The selected production handlers
use explicitly mocked provider/storage dependencies where applicable. These are
new branch results, not copied #1510 or historical #1509 totals.

After the evidence update, source package validation passed for three distribution
files. Release validation correctly exited **2 / RELEASE_BLOCKED**, with fourteen
blocker codes and no archive written. Documentation passed **740 checks, 0 failures,
0 warnings**, including local link-target checks; the separate documentation-link
audit was not rerun in this validation cohort. All four generated indexes were
current, including the explicit `reindex:check`. Sync passed with **0 errors,
0 warnings and 5 informational notices**, and the staged commit guard passed.
Those evidence-update checks completed at 18:09 UTC against index tree
`358ec0330a1a4a830dd020435c0d39736496ef20`. Final review/documentation edits
require the final documentation, sync and staged-guard checks before publication.

Historical sealed-preview results remain **hosted156/156 PASS and independent156/156
PASS** at7f4e8c6 only, synthetic and predating runtime repairs. They do not verify
migrated-skill behavior, current live acceptance or old/new parity.

## Remaining migration work

1. Capture the latest published GPT baseline and complete knowledge inventory.
2. Bind all old-GPT parity cases to that baseline (currently0/16).
3. Obtain separate explicit owner approval immediately before Migrate to plugin.
4. Inspect actual migrated skill and references.
5. Run paired parity.
6. Release/merge #1509 only after all blockers clear.

The owner may continue baseline capture and old-GPT evidence collection.
**Do not proceed to the migration confirmation yet:** runtime acceptance remains
failed, the baseline is absent, and old/new artifact and parity gates remain blocked.
Keep #1509 DRAFT with auto-merge disabled. No Custom GPT, Actions, final package
installation or migration action was performed.

## Evidence hashes

Only hashes, timestamps and reviewed summaries follow. Raw conversations and
answers remain under the ignored private migration-input directory.
Raw answer hashes cover the exact structured MCP answer string as UTF-8.
ChatGPT answer hashes cover the captured visible plain-text transcription, not
transport Markdown bytes. The separately preserved supported thread export differs
only by bold/blockquote markers and hard-break spaces. Neither capture exposes a
same-invocation raw ChatGPT tool result.



### raw A

UTC: 2026-09-24 17:56:31 UTC to 2026-09-24 17:56:46 UTC

Prompt SHA-256: 1889539d24060a7448ed3eb74171dead3e7381ab5121aaef6638d995cba4ef0a

Answer SHA-256: 6b46489ea27b985ab9d6b3f47e4a163b09afcde19b2d3651cbac00d51483779c

Sanitized summary: Model generation succeeded; three sentences including irrelevant live-access disclaimer. Equality explanation correct; requested two-sentence format failed.

Summary SHA-256: 7a84c600faee847b158a877220a7f10b989d29afdb6bfd19259ddd651df0d02d

### raw B

UTC: 2026-09-24 17:56:55 UTC to 2026-09-24 17:57:04 UTC

Prompt SHA-256: a279828f7f7dddf6b5c4b1db30744a4fd9642b19868727c956836612670c5ae8

Answer SHA-256: 4dbb490ed824249452629686d9c7aa525c5ec3c9945e0f4f862fa42dbe13230f

Sanitized summary: Model generation succeeded; two short sentences, no heading or disclaimer; equality explanation correct. Actual LF submitted as part of prompt.

Summary SHA-256: 89cccb708798483ed730cbaf871b60b479a0df18d24d8f086fbeb6d1ad0ef8ac

### raw C

UTC: 2026-09-24 17:57:12 UTC to 2026-09-24 17:57:20 UTC

Prompt SHA-256: b2c07437f5fba2109af65016e18b70da578e5cd84d259db3b446385fac6b96aa

Answer SHA-256: 70f9555794c303c43efb2113a8642fcae748f07c45856af8a39c9e321a9108cc

Sanitized summary: Model generation succeeded; two sentences including irrelevant live-access disclaimer. Equality explanation present; requested learner cross-multiplication instruction missing.

Summary SHA-256: 3c146e82f204ca6e099218a4354bd74e418dae0b25232c4de48efb37cbac6388

### raw D

UTC: 2026-09-24 17:57:28 UTC to 2026-09-24 17:57:31 UTC

Prompt SHA-256: 346f6c176ff641bb26b1b86885d73da9c4df49de0fc87589c99ae1cc00fb5db4

Answer SHA-256: 381ee2bc127a3bd5b5036eacd3603e2c90983cc400cf8c90e38e47c821f7ae9e

Sanitized summary: Model generation succeeded; irrelevant disclaimer precedes three inline numbered markers. Correct solution x=3, zero separately numbered lines; no-introduction request failed.

Summary SHA-256: 088e200bfde21e56cd5016dbfdeff68a80ef6f6d09dc3f681fa02d4cb0a3ecc7

### chatgpt A

UTC: 2026-09-24 17:58:38 UTC to 2026-09-24 17:59:20 UTC

Prompt SHA-256: 1889539d24060a7448ed3eb74171dead3e7381ab5121aaef6638d995cba4ef0a

Answer SHA-256: 71b40d0ed7b67ae85913859d0a60c1b8404d52801a7574d1ed231e7603ea6c34

Sanitized summary: One requested invocation in new ChatGPT Work conversation returned UNAUTHORIZED/expired-connection card. Account selected by that invocation not exposed. No Tutor answer; not a format failure.

Summary SHA-256: fdac54a8ab707b5475d9475f3cc64257a30c9e20f6ec567929c34ff9743380f5

### chatgpt B

UTC: 2026-09-24 17:59:53 UTC to 2026-09-24 18:00:47 UTC

Prompt SHA-256: a279828f7f7dddf6b5c4b1db30744a4fd9642b19868727c956836612670c5ae8

Answer SHA-256: 4dbb490ed824249452629686d9c7aa525c5ec3c9945e0f4f862fa42dbe13230f

Sanitized summary: Explicit Primary account requested. Displayed two short sentences, no heading or disclaimer. Tool activity entry observed; exact same-invocation raw payload and argument newline not exposed. Display-only pass, end-to-end attribution unverified.

Summary SHA-256: 73e0269f235101d1764fe0a10ca70e30bb5baf8c01c68de85d6675b3286a1ebf

### chatgpt C

UTC: 2026-09-24 18:01:27 UTC to 2026-09-24 18:02:27 UTC

Prompt SHA-256: b2c07437f5fba2109af65016e18b70da578e5cd84d259db3b446385fac6b96aa

Answer SHA-256: 24ac883c1bbd54febace49fd07d38145d2a2e791e922c28258601cd55ec2a06b

Sanitized summary: Explicit Primary account requested. Displayed output includes introduction, quoted disclaimer/equality explanation, and two commentary sentences; four sentences overall and no learner cross-multiplication instruction. Same-invocation raw payload unavailable; origin attribution unverified.

Summary SHA-256: b41423f20907ab94fedd24f1781b67122116adcf78d7a2b0a50fc3dc659e7e3f

### chatgpt D

UTC: 2026-09-24 18:02:27 UTC to 2026-09-24 18:03:44 UTC

Prompt SHA-256: 346f6c176ff641bb26b1b86885d73da9c4df49de0fc87589c99ae1cc00fb5db4

Answer SHA-256: 90a4c5daa6dc4850ee090b2ddf4721667686138835aea28d6f503d40e60edef7

Sanitized summary: Explicit Primary account requested. Displayed output includes introduction, quoted disclaimer and three inline numbered markers, then commentary. No-introduction/step-layout request failed. Same-invocation raw payload unavailable; origin attribution unverified.

Summary SHA-256: 4494f687372199c403f9b58b017265577391b3c977402876c2f3421f1d39da58
