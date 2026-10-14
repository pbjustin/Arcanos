# Gaming source acceptance repair — 2026-10-13

This is code-review evidence, not production recovery. Baseline:
`c8bb00ee000e3e188f17e1aa2b5e2893d0221fb8` (`main`, PR #1541).
The final published commit and automatic CI snapshot belong to the draft PR
handoff; [validation.json](validation.json) binds the local checks to exact
source and fixture SHA-256 fingerprints. All fixture documents are synthetic,
not copied publisher articles or current gameplay recommendations.

## Gate assessment

| Gate | Result | Evidence / limit |
| --- | --- | --- |
| Root cause established | PARTIAL | Three code defects reproduced on untouched main; original publisher bodies are unavailable, so eight historical identity decisions remain unresolved. |
| Deployment identity | UNVERIFIED | `DEPLOYED_SHA_UNVERIFIED`; exact checkout/upload correlation exists but immutable deployed-content-to-Git attestation does not. |
| Elden Ring regression | PASS | Generic article identity, integrity controls and actual hybrid v2/Trinity orchestration with mocked provider transport. |
| Fallout 76 regression | PASS | Heavy Gunner topic identity, distinct Fallout titles and the same end-to-end path. |
| Wrong-game negative controls | PASS | Fallout 4/3/New Vegas, Nightreign, acquired declarations and expansion conflicts. |
| Extraction integrity | PASS | Real HTML extraction; complete, partial, ambiguous and truncated units; furniture exclusion. |
| Hybrid v2 E2E | PASS | Two grounded successes and four bounded stopping cases; provider responses are synthetic. |
| Security invariants | PASS | Local transport, redirect, DNS rebinding, timeout/budget, provenance, revision, idempotency, storage and preview-containment assertions. |
| Full CI | NOT_RUN | At this prepublication snapshot. The draft PR's exact-head check rollup is authoritative after publication. |
| Live acceptance | NOT_RUN | No live workflow or provider call was authorized or started. |
| Merge readiness | BLOCKED | Draft; required `docs:check` and `All Checks Complete` must pass on its final head. No merge authorization. |

## Deployed code and incident evidence

[Deployment identity](deployment-identity.json) records read-only Railway CLI
metadata/startup inspection and GitHub rollout log correlation. Successful
[rollout run 38496134303](https://github.com/pbjustin/Arcanos/actions/runs/38496134303)
checked out `c8bb00ee` and queued worker
`331f7741-3eaa-4fcb-828e-4bc99898a67f` and web
`20916344-c022-4524-b0ce-fa4ad06aea10`. Both incidents are confirmed on that web
deployment after startup. Railway metadata omits the current Git commit and
startup reports `git=unknown`, `branch=unknown`. Image digests identify images,
but the available evidence does not immutably bind those images to a Git tree.

[PR #1531](https://github.com/pbjustin/Arcanos/pull/1531), merged at
`200463b3aac65eb494f71d842c1e2b0378530bfb`, is an ancestor of the upload checkout.
Its declaration grammar, furniture isolation, container selection, qualifier
counting and record-integrity fixes are present in reviewed main. Later PRs
#1533–#1535 add the generic registry/scoped evidence/diagnostics; #1538 repairs
discovery, topic ownership and request coverage. Treating these as incidents
from before PR #1531 is unsupported. Presence in the correlated upload checkout
is corroboration, not immutable deployed provenance.

[Incident diagnostics](incidents.json) contain 36 correlated events and all 12
candidate stage traces. Source names below come from the owner's ordered source
lists, matched to per-round submission indices; logs omit exact submitted URLs.
`C/P/A` means complete/partial/ambiguous extracted units. Rule names in the
identity rows have the prefix `gaming.identity.`. All downstream selection and
generation stages were not run after these failures.

| Incident / source | First failure | Exact rule or acquisition subreason | C/P/A | Classification |
| --- | --- | --- | --- | --- |
| A: wiki.gg Samurai | identity, GAME_MISMATCH | distinct_body_scope | 0/0/3 | Unresolved original body |
| A: ESO Wiki Uchigatana | identity, GAME_MISMATCH | affirmative_body_scope_conflict | 25/10/14 | Unresolved original body |
| A: Game8 | identity, GAME_IDENTITY_UNVERIFIED | independent_anchor_required | 25/46/28 | Unresolved; content_truncated recorded |
| A: Mobalytics | acquisition, SOURCE_INACCESSIBLE | HTTP_RESPONSE_UNUSABLE, HTTP 403 | unavailable | Correct observed transport rejection |
| A: Gamepur | acquisition, SOURCE_TIMEOUT | DEADLINE_EXCEEDED | unavailable | Correct observed deadline rejection |
| A: Eneba | identity, GAME_MISMATCH | instruction_heading_conflict | 0/9/0 | Unresolved; partial units |
| B: Fallout Builds beginner | identity, GAME_IDENTITY_UNVERIFIED | independent_anchor_required | 0/0/0 | Unresolved; prose acquired |
| B: NerdBurglars | identity, GAME_MISMATCH | affirmative_body_scope_conflict | 0/18/0 | Unresolved; partial units |
| B: TimeSaver 2026 | acquisition, SOURCE_TIMEOUT | DEADLINE_EXCEEDED | unavailable | Correct observed deadline rejection |
| B: Fallout Builds overview | identity, GAME_MISMATCH | affirmative_body_scope_conflict | 1/0/10 | Unresolved original body |
| B: Nuka Knights | identity, GAME_MISMATCH | affirmative_body_scope_conflict | 0/1/36 | Unresolved; ambiguous units and latency |
| B: Fallout Builds 2025 | acquisition, FETCH_BUDGET_EXHAUSTED | candidate loop deadline guard | unavailable | Correct stop before acquisition |

ESO's 25 complete units coexist with ten partial and fourteen ambiguous units;
the document has no recorded truncation stage. Completeness describes the
record's structure, not its game. The first failure was an affirmative body
scope conflict, so those complete records never reached applicability,
selection or Trinity. Game8 independently also had 25 complete units, but lacked
the required independent identity anchor. Neither count proves either
publisher's identity decision was incorrect. Tests explicitly retain rejection
of 25 complete records when game proof is missing.

The logs cannot establish whether navigation, headings, comparisons or actual
wrong-game prose caused any particular identity decision. They contain no
offending spans. Acquisition failures are separate from identity failures and
do not prove a general lack of available gameplay evidence. Both terminal
responses stop with `CANDIDATE_SOURCES_REJECTED`, no selected evidence or answer,
and no recovery remaining.

## Confirmed code defects and intentional changes

1. `isGamingAcquiredTopicTitle` required a guide/build-like suffix. Closed labels
   such as **Early Game** and **Heavy Weapons** therefore could not use the
   existing affirmative acquired-body identity path. The predicate now admits
   closed equipment/weapon/skill labels and Early/Late Game as topics. A topic
   label still supplies no game proof by itself.
2. The topic vocabulary omitted heavy, gunner, power, armor and armour. Heavy
   Gunner guide headings could invent an uncatalogued game and override valid
   acquired identity. These five words now participate only in the closed topic
   grammar; explicitly named games with those words remain authoritative.
3. The registry lacked Fallout titles. That prevented generic Fallout 76 topics
   from using acquired alias recognition, and also missed contradictory
   affirmative Fallout 4/3/New Vegas clauses under a Fallout 76 title. Exact
   entries and the punctuation alias for New Vegas repair both directions.
   They add no publisher trust, edition default or storage permission.

Only `gamingGameDetection.ts` and `gamingGameRegistryData.ts` change production
behavior. Existing independent-anchor, explicit declaration, scoped game and
edition, provenance, incomplete-record, SSRF, redirect, timeout, acquisition
budget, recovery, protocol and storage gates are retained. The two reviewed
semantic file pins and generated indexes follow those source changes.

Final identical fixtures were copied into a detached baseline worktree without
editing its tracked source. Identity/extraction: **9 failed / 16 passed** on
baseline, **25 passed** after repair. E2E: **5 failed / 1 passed** on baseline,
**6 passed** after repair. The baseline Fallout E2E negative stopped unverified;
the direct identity regression separately demonstrates the false acceptance of
an appended wrong-game clause. Failed E2E positives stopped before generation.

## Verification and fixture boundaries

[Validation receipt](validation.json) contains exact commands, result counts,
failed baseline assertion names, test-file selection and tested fingerprints.
Toolchain: Node **24.18.1**, npm **11.16.0**. The permanent fixtures are:

- `tests/fixtures/gaming-source-acceptance.ts`: original synthetic HTML for both
  games, ordinary starting progression, generic headings and unrelated furniture.
- `tests/gaming-source-acceptance-identity.test.ts`: real HTML normalization and
  extraction, independent anchors, three incident conflict rules, Fallout title
  isolation, Nightreign/DLC, 25 complete records without proof, incomplete units
  and a late contradiction after 70k characters.
- `tests/gaming-source-acceptance-acquisition.test.ts`: protected resolver with
  synthetic HTTP/DNS only; separate 403, timeout and unattempted budget exhaustion,
  unsafe initial URLs, forbidden redirects and DNS rebinding.
- `tests/gaming-source-acceptance-workflow.integration.test.ts`: actual v2
  workflow, acquisition, validation, coverage, provenance, selection, Trinity
  intake/reasoning/final and bound CLEAR answer audit. Only external transports,
  empty corpus retrieval and persistence boundaries are substituted. Assertions
  bind each answer sentence to selected acquired passages, source/evidence IDs,
  citations and the original question. Semantic model judgment is synthetic.
  Both games also stop after bounded recovery for incomplete coverage and
  wrong-game sources, with no provider invocation. Database and durable writes
  are trapped and asserted unused; duplicate submissions reuse the result.

The E2E prose-only guides intentionally contain sufficient complete prose.
They do not promote partial structured records into document-wide applicability.
Fallout's fixture explicitly treats Heavy Gunner equipment/perks as a later
goal, not equipment automatically available on leaving Vault 76. Current-patch
compatibility remains qualified rather than invented.

## Residual risks

- Original publisher identity classifications and contamination remain
  unresolved without the exact acquired bodies. The new fixtures reproduce
  code defects, not historical publisher content.
- Nuka Knights consumed 37,021ms overall versus 2,879ms recorded extraction,
  then the last candidate exhausted its budget. Available timings do not isolate
  the expensive operation. The synthetic 70k-character control did not reproduce
  this delay; no timeout or limit was widened to hide it.
- An existing uniform wrong-game batch can expose top-level
  `QUESTION_COVERAGE_INSUFFICIENT` while preserving each candidate's exact
  `GAME_MISMATCH` stage and stopping without generation. This aggregate wording
  does not explain either mixed production incident and is unchanged.
- No live provider, installed plugin, new production workflow, SQL/storage,
  preview deployment or production recovery was exercised. No merge, Railway
  mutation, configuration/secret change, ingestion or durable Gaming storage was
  performed. Passing local tests is not production acceptance.
