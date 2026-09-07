# Request-scoped Gaming guide assistance

The guide-assistance policy is `gaming-guide-assistance/v1`. It extends the
existing Gaming retrieval and Trinity pipeline. It does not create conversation
memory, change configured model identities, refresh sources, or authorize a
deployment.

## Request flow

Previously, intent extraction recognized platform, version, class, role,
difficulty, progress, constraints, and spoiler preferences, but
`BackendQueryAgent.build()` did not forward them. Stored candidate acquisition
used the question and game alone. Trinity intake used a generic framing prompt
with 500 output tokens; reasoning received its framed request without the
original evidence. Grounded guide prompts already answered the question first,
and successful guide composition already passed provider prose through once.

Now the public validator checks bounded optional flat fields, the intent and
backend mapping retain the validated player claims, and the backend validates
again before retrieval. Live and stored lexical retrieval use the same bounded
request/context distinction. Selected evidence enters the Gaming prompt within
its untrusted-data boundary. The ordinary Trinity intake, reasoning, CLEAR, and
final stages retain the original request/evidence, then Gaming projects compact
source-number citations and applies lightweight response composition.

The implementation base is `abb3e89ccfd69f8cb7cfb311ca4cdd7c45c2ab60`, fetched from
`main` on September 7, 2026. Historical request `req_1788735955551_b3xj3` motivated
the mocked incomplete-completion regression. Its historical logs do not prove
the cause of any current production model response.

## Context contract and precedence

Use the existing `game`, `mode`, and `prompt` fields. Optional player fields are
`platform`, `edition`, `version`, `difficulty`, `currentArea`,
`lastCompletedObjective`, `progressPoint`, `class`, `role`, `constraints`,
`spoilerTolerance`, and `answerDepth`. See [API.md](API.md) and
[the Gaming Action schema](../contracts/arcanos_gaming.openapi.v1.json) for
request examples and aliases. No field lets callers adjust server token limits
or select the trusted intake policy.

String caps are 64 characters for platform/version/difficulty/class/role, 120 for
edition, 160 for area/progress, and 240 for the last completed objective.
Constraints allow eight strings of 160 characters each. Aggregate context is
limited to 2,000 characters. Existing 8,000-character prompt, 120-character game,
URL-count/length, structural, and transport body limits remain in force. Unknown
payload fields and invalid enum values are rejected. Server-derived origins,
conflicts, and effective spoiler mode cannot be submitted as public fields.

Explicit fields take precedence over missing-context extraction from the
current question. Strict first-person progress statements can supply missing
area, objective, or checkpoint values. Broad class/role/version extraction is
tentative. Negated and hypothetical progress, a question about defeating a boss,
and areas appearing only in sources do not establish completed objectives.
Contradictory structured/current-question claims are recorded as conflicts;
guidance must ask one targeted question or provide scoped alternatives when the
conflict changes the answer. Source titles do not establish edition or player
state, and explicit precise game titles are preserved.

`answerDepth` accepts `auto`, `concise`, `standard`, or `detailed`. Clear current
question requests for brevity/detail take precedence over the structured depth.
Auto uses concise guidance for next-step/location questions and standard depth
for strategies, walkthroughs, diagnostics, and broader explanation. These are
prompt preferences within existing hard budgets, not output truncation rules.

`spoilerTolerance` accepts `none`, `light`, and `full`, as well as legacy values.
`avoid` maps to `none`; `allowed` maps to `full`; omitted/`unknown` conservatively
maps to `none` without claiming an explicit user preference. Existing accepted
aliases remain supported. When structured and textual preferences disagree, the
stricter permission wins. None permits immediate objectives and essential
mechanics; light permits necessary near-term progression; full permits relevant
spoilers. An inherently spoiler-sensitive question under none gets the safe
portion or one concise clarification. The final Trinity pass retains this
policy and the original constraints.

## Intake completion and budgets

The server-owned `gamingGuideIntakePolicy: compact-v1` is accepted only for the
Gaming module's guide endpoint and guide request. It asks for a plain-text task
card of at most 120 words: question, material player constraints, and evidence
references. It explicitly forbids writing the walkthrough at intake. Original
bounded evidence remains available independently of that card.

The intake allocation remains **500 output tokens**, selected through the
existing provider token-parameter adapter. Supported models receive disabled
reasoning effort for this compact intake task; configured model identities do
not change. There is **no new recovery attempt**. A settled length/incomplete
completion throws `OPENAI_COMPLETION_INCOMPLETE`; no partial text is accepted as
a completed task card or concatenated into an answer. Repeated incompleteness,
provider errors, exhausted runtime, and cancellation remain terminal/degraded.
Successful-looking fallback, dry-run, or incomplete Trinity results are not
promoted to completed guide answers.

Existing default guide budgets remain a 60-second module window, 50-second
pipeline window, 24-second stage window, and 500 ms runtime safety buffer, with
existing request-deadline clamping and session/global provider limits. Ordinary
guide requests retain the full Trinity sequence even when the question asks to
"answer directly". The pre-existing exact-literal compatibility shortcut remains;
the existing self-heal final-stage bypass remains a fallback and cannot become a
completed grounded guide answer. Optional pattern storage and raw audit content are disabled
for this request-scoped guide policy. Non-Gaming behavior remains on its existing
path.

## Retrieval, spoilers, and attribution

`gaming-player-retrieval/v1` separates exact question terms from supporting
area/checkpoint/objective/class/constraint terms. Specific item/boss terms stay
the relevance anchor; for an ambiguous question such as "What next?", player
context supplies that anchor. Platform, generic difficulty, edition/version,
and presentation preferences do not become topical acquisition terms. Candidate
acquisition is bounded to 16 lexical terms and 20 stored candidates.

The existing 25% topical-coverage floor and 65% coverage/35% normalized SQL-rank
score remain. Supporting context adds at most 0.08 to ranking; deterministic
identity ordering resolves ties. Existing duplicate/overlap penalties, active
source/revision constraints, source/chunk caps, and the default 5,000-character
evidence budget remain. No minimum chunk count is imposed. Zero relevant results
remain valid, and supplied-guide zero-evidence suppression still blocks an
unsupported provider call.

Known verified patch mismatches are excluded using existing version comparison.
Unknown edition/version compatibility is not invented. Storage does not provide
trustworthy general game progression chronology or edition metadata, so the
policy does not equate chapter/chunk order with progression or apply speculative
hard progression exclusions.

Conservative spoiler modes select relevant evidence units and omit optional
prose titles/headings from provider and public source presentation. Full mode
can forward sanitized, bounded headings; metadata overhead counts against the
context budget. Internal evidence retains source ID, revision ID, record ID,
public URL, ordinal/offsets, and sanitized headings where available. Several
chunks from the same document keep one public source number. Citations identify
supporting documents; a valid number alone is not proof of claim support.

Lexical filtering cannot guarantee spoiler-free arbitrary prose. An essential
mechanic and a future reveal may share one sentence; source URL paths may reveal
names; pronoun-only dependent passages can be missed. There is no claim of
semantic/paraphrase recall or perfect spoiler detection. The generation policy
must still scope the answer to the question and effective spoiler permission.

There is no selected-answer cache in the Gaming/Trinity/module path. Source
document and discovery caches remain enabled. Context-dependent selection runs
after raw cache reads, preserving per-request checkpoint/spoiler decisions and
current stored active-revision reads. No cache is globally disabled. Telemetry
records bounded policy/task/depth/spoiler values, context presence/origins,
candidate/selection counts, context size, and intake completion/usage; it does not
log guide passages, complete private prompts, or hidden model reasoning.

## Deterministic verification and quality evaluation

[The synthetic corpus](../tests/fixtures/gaming-guide-assistance.json) contains
an adventure, an action game, and a ship-systems game. It includes reference
answers and a reusable rubric for clarity, actionability, support, spoilers,
and appropriate detail. For example, the adventure's "What next?" previously
lacked an acquisition anchor; with Copper Canal plus repaired pump, the reference
answer is: "Turn the blue valve beside the canal lift, then cross once the bridge
locks in place. The lit bridge lamp confirms it is ready. [1]"

The action-game case requests a detailed Ash Sentinel strategy despite a
structured concise preference. Its reference answer explains the raised-arm cue,
safe movement, supported punish window, and limits of the difficulty evidence.
The ship case requests a short explanation despite structured detailed depth;
its reference answer explains capacitor charge in two sentences. These are
synthetic reference answers, not measured before/after live-model outputs.

Run the focused corpus with the pinned runtime:

```powershell
node scripts/run-jest.mjs --runInBand --runTestsByPath tests/gaming-answer-policy.test.ts tests/gaming-player-context.e2e.test.ts tests/trinity-gaming-intake.test.ts --coverage=false
```

Mocks prove contracts, stage inputs, selection, safety, bounds, and projection.
They do not prove live model compliance. Live evaluation is disabled by default;
no live-model evaluation, production database test, source refresh, or deployment
is part of this change. The repository currently has no suitable bounded Gaming
live-model evaluation runner, so no generic live command is repurposed.

## Custom GPT operator step

This PR updates repository schemas only. After a separately authorized backend
release, open the deployed Gaming Custom GPT in **Edit GPT → Configure →
Actions**, select its existing ARCANOS Gaming Action, and replace its schema with
the complete contents of `contracts/arcanos_gaming.openapi.v1.json`. Preserve
the existing server URL, authentication, and access scope, then save/update the
GPT. If it uses the generic router Action instead, refresh from
`contracts/custom_gpt_route.openapi.v1.json`. This repository PR does not perform
that manual configuration change or authorize backend promotion.
