# Installed Tutor teaching observations — 2026-09-26

This run exercised 15 of the 18 teaching-matrix cases on the installed private
ARCANOS TUTOR 0.8.3 plugin. Three additional explicit-selection observations
investigated uncertain activation. One additional learner check-in supplied real
conversation context and is not a scored case. These are observed ChatGPT
responses, not synthetic decision fixtures.

The run found three teaching omissions with positive Tutor attribution: the
direct explanation, guided hint, and explicit worked example requested a
confidence/time check-in without providing the requested teaching. The
cross-plugin request was correctly refused, but Tutor activated despite the
matrix expecting nonactivation. The memory response suggested unsupported
persistent-profile functionality; host memory influenced that response and
Tutor attribution was not established.

**TUTOR_SKILL_BEHAVIOR_VERIFIED remains BLOCKED.** No private skill revision,
plugin release, account/connection change, deployment, or
merge was performed in this phase.

## Release and execution binding

- Repository source head: `67cb5f815e11bab637bca102aa4a0a823b7ba66d`.
- Existing plugin: `plugin_d292d1e45ae08191b3911299e30e1a25`.
- Current release: `pluginrel_6ab7f17cb4288191b6a60b25c98d5505`.
- Version/visibility: `0.8.3`, PRIVATE; current metadata rechecked after testing.
- Approved installed/saved skill SHA-256:
  `7661b328b99aa096f930f46e272ef9208de6f11e22c002e77f79d9ab78a15096`.
- Actual saved package fingerprint:
  `e88b0dc42a9951869b8ff63c999e1b6a02fd08043df96f154012c165c8d99948`.
- Surface: ChatGPT web, Chat mode, model selector labeled Medium. The UI did not
  expose an exact underlying model ID.
- Existing app and Primary connection were preserved. The optional app was
  connected during ordinary cases; no disconnection was simulated.
- Exact matrix prompt text was retained. Explicit selection added the supported
  plugin mention. Implicit observations had no plugin selection.
- Adaptive and follow-up cases used actual preceding messages in their chats.
  The memory case used personalized Temporary Chat, which still referenced host
  memory; it was not a memory-isolated test.

Current [OpenAI migration guidance](https://learn.chatgpt.com/docs/migrate-custom-gpts#understand-the-change)
calls for testing both explicit selection and ordinary task requests. Its
description of automatic selection is not a guarantee that every eligible task
loads a skill.

## Case observations

Content results below assess the specified response constraints only. They are
not complete case or release passes. “Observed” means the host Sources panel
listed `arcanos-tutor`; correct prose, explicit selection alone, and the model's
own claims were not accepted as activation proof.

| Matrix case | Content | Activation evidence / limitation |
| --- | --- | --- |
| DIRECT_EXPLANATION | FAIL: requested explanation omitted | Observed, explicit selection |
| DIAGNOSTIC_ASSESSMENT | PASS | Observed, implicit discovery |
| ADAPTIVE_REEXPLANATION | PASS | Earlier turn confirmed Tutor; current-turn activation unknown |
| WORKED_EXAMPLE | Implicit PASS; explicit variant FAIL: example omitted | Initial activation unknown; explicit variant observed |
| GUIDED_HINT | FAIL: useful hint omitted | Observed, explicit selection |
| PRACTICE_GENERATION | PASS in both observations | Initial activation unknown; explicit variant observed |
| PRACTICE_FEEDBACK | PASS | Observed, explicit selection |
| COMPREHENSION_CHECK | PASS | Observed, explicit selection |
| CONCISE_FORMAT | PASS: two short sentences | Observed, explicit selection |
| NUMBERED_FORMAT | PASS: three numbered steps | Observed; screenshot verifies numbering |
| DIFFICULT_OR_AMBIGUOUS_QUESTION | PASS | Observed, explicit selection |
| FOLLOW_UP_CONTEXT | PASS in both observations | Initial activation unknown; explicit variant observed |
| MEMORY_REQUEST | FAIL against Tutor scope contract; attribution confounded | Sources showed three host memories, no Tutor skill marker |
| UNRELATED_WRITING | PASS: general writing response | Nonactivation remains unverified |
| CROSS_PLUGIN_BOUNDARY | PASS: refuses unsupported operations | FAIL: observed activation conflicts with expected false |
| BACKEND_EXPLICIT | NOT RUN | Separate backend authorization required |
| BACKEND_UNAVAILABLE | NOT RUN | Requires an actual prior failed call; no fabricated failure |
| ORDINARY_TUTORING_WITH_APP_DISCONNECTED | NOT RUN | Primary remained connected; literal precondition absent |

Across the 18 scored response observations there are 14 content passes and four
content failures. These observations cover 15 distinct matrix cases, not 18
distinct cases. The separate cross-plugin activation failure is not included in
the content-failure count. Variants retain the original results rather than
replacing them.

## Backend and privacy limits

No backend invocation was issued by this task, and none was visible in captured
ChatGPT responses or available thread summaries. Those surfaces are not a
complete server invocation trace. The authoritative backend count remains
unknown; **zero-backend-call verification is not claimed**. No tool approval,
reconnection, new app/connection/Auth0 client, or scope change was performed.

Raw prompts/responses, screenshots, source panels, host-memory details, thread
locators, inventories, and the execution ledger remain under the ignored
`.local-migration/arcanos-tutor/installed-teaching-20260926/` directory. The
approved teaching instructions remain private and byte-for-byte unchanged.
The private execution ledger inventories 56 raw evidence artifacts. Its size is
144,242 bytes and SHA-256 is
`27e74586e2c14f67a4de3295f2eb96cbcb798eed4eb941a0327398cfb5d56b61`.
The [saved-release record](TUTOR_OPTIONAL_APP_RELEASE_20260926.md) remains the
authority for archive identity and package bytes.

The historical reference matrix and its validator remain unchanged. Their
teaching binding uses the composed-package fingerprint, while these installed
observations bind the actual saved release. The difference was not concealed by
substituting fingerprints or weakening validation.

## Gates and next work

The seven verified migration/baseline/composition/reconciliation/app/archive
gates remain verified. Teaching behavior, live Tutor acceptance, migrated parity,
package readiness, and release readiness remain BLOCKED.

Next work is owner review of the observed teaching omissions and a proposed
minimal change, with a new skill approval required before changing the approved
bytes. Separately, complete activation and zero-call observability, test a real
disconnected state through an authorized control, obtain separate authorization
for explicit backend execution/failure handling, and perform migrated parity.

Independent artifact and integration review assess the observations separately
from source/package integrity. Local validation and exact-head CI are recorded
in the PR update; a blocked release-validator result is expected.
