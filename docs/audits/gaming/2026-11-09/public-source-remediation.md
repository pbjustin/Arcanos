# Public guide acceptance remediation

This follows the [independent acceptance audit](pr1595-end-to-end-acceptance.md).
It preserves that historical audit and its unsuccessful public captures. The
starting remote head was `a7c04e3224b70b3d30df007a240646b6d3081d8d`, matching
the supplied revision; the original base remained
`eea2d0b6ed72d00e3489a9f8ddf45335b3aa1e86`. The PR was open, draft and
mergeable. All seven existing review threads were resolved; no additional bot
review was requested.

## What was actually exercised

The real compiled protected HTTPS reader and normal v2 candidate evaluator ran
against public publishers. DNS, HTTPS, extraction, independent identity, source
CLEAR and gameplay passage selection were **not mocked**. A passive transport
observer recorded response status without changing requests or responses. The
isolated process removed provider, Gaming and database credentials before imports.
The normal per-document and submission limits remained binding; a separate
24-second outer cancellation limited each diagnostic batch. These independent
candidate checks are not additional rounds in a player workflow.

The final prepublication captures include uncommitted runtime repairs above their
recorded execution HEAD. Those source changes were subsequently committed as
`21762684`; the observation artifact records the runtime file hashes explicitly.
Published exact-head checks and later rechecks belong to the PR verification
receipt, rather than rewriting these historical captures.

No Gaming login, live backend search, Trinity model, production endpoint or
durable source ingestion was used. An `eligible_for_ingestion` decision describes
eligibility, not consent or an executed write. Article bodies were retained only
in ignored local diagnostics; the committed [sanitized observations](public-source-remediation.json)
contain URLs, hashes, measurements, decisions and reason codes, without copying
publishers' articles. A source acceptance is not a completed user-facing answer.

## Distinct failure causes and bounded repairs

| Source | Reproduced cause | Result and boundary |
| --- | --- | --- |
| Thonky, Ocarina of Time | The complete selected article has useful instructions but lacks the required independent body-level game declaration; the game appears in acquired title/navigation | Rejection retained. Request, URL, search title and publisher cannot supply the missing proof. A separately discovered QuestDuo walkthrough passes normal source acceptance and passage selection. |
| Frontier, Elite Dangerous | Ordinary plural possession was misread as a family-scope suffix and as an unclosed quotation | Corrected the two grammatical parsing boundaries. Acquired source text and all applicability declarations remain intact. The real source passes identity, applicability, source CLEAR and passage selection. Its publication date does not establish the latest patch. |
| DualShockers, Elden Ring | A double-hyphen independent clause was included in a game name | Corrected the implicit grammatical boundary, retaining explicit names, unknown titles and edition/expansion qualifiers. Identity now verifies. Existing bounded structured-data inspection still reports incomplete material; freshness/source CLEAR rejection is retained. |
| Silverback Research Institute | The acquired HTML contains an empty application root and an external script, with no server-delivered guide text | Unsupported JavaScript shell; rejection retained. No renderer, crawler, proxy or alternate identity added. |
| ConsolePulse, Xenoblade Chronicles 2 | Server-delivered guide sections were in bounded static streaming placeholders; related-game navigation and an event-list spoiler warning then caused false game conflicts | Restored only one reviewed static transport form without executing JavaScript. Removed one overly broad navigation keyword and distinguished a narrowly bounded spoiler event list from a game declaration. Text is recovered; independent game proof remains separately required. |
| E:D Black Box | The primary selector preferred a small article card; the source's player progression phrase also matches the strict system-role instruction filter | Both limitations remain. A structural-wrapper selection prototype exposed an authored foreign-heading false-acceptance case and was withdrawn. The role filter remains strict: safely distinguishing a fictional role from control-role assignment requires more than a publisher-specific exception. The source remains unaccepted. |
| Previously observed HTTP 403 publishers | Access denied by publishers | Existing classifications retained. These URLs were not retried through cookies, proxies, alternate identities or bypasses. |

The Elden Ring structured-data limit predates this PR: a decorative JSON string
exceeds the existing scalar-inspection cap, so extraction remains conservatively
partial. No inspection allowance, timeout, acquisition round or CLEAR threshold
was increased to accept it. Removing a false identity conflict is not equivalent
to accepting the source.

The HTML restoration is Gaming-only, after the existing complete-response
instruction/source-use scan. It admits only closed, ordered literal relationships
with an exact reviewed helper, bounded segment count and existing byte, element
and deadline limits. Duplicate IDs, missing/cyclic/reused segments, inert contexts,
altered helpers, ambiguous order and truncated transport fail closed. Hidden or
navigation content at the destination retains its normal exclusion. Original
response bytes and provenance are unchanged. Resolver revision
`gaming-document-v12` separates changed extraction and identity behavior in cache
and durable revision identity; it grants no authority to old rows.

The current CI failures at the starting head were independently traced to the
strict PostgreSQL command truth fixture: the new held-out suite had been added to
the command but omitted from the fixture's exact expected list. Both CI unit jobs
reported that same assertion. Adding its actual existing path repairs the
introduced omission without weakening the assertion or changing CI execution.

The relevant identity, quotation, navigation, static-shell and instruction-filter
behavior exists in the original base; the repairs address pre-existing acceptance
gaps exposed by these public articles. Attribution was checked against the
original-base implementation diff. Failing-before fixture runs use the exact
starting PR head, not an assertion that every original-base scenario was rerun.
The command truth-fixture omission is introduced by the preceding PR commit.

## Acceptance boundaries and remaining work

Permanent authored regressions were copied as tests only into a detached exact
`a7c04e32` checkout; its production-source diff remained empty. They use controlled
external effects, not the live publishers' articles:

| Focused fixture set | Before repair | After repair |
| --- | --- | --- |
| Acquired possessive/dash scopes and existing adjunct controls | 44 passed, 6 failed | 50 passed |
| Explicit spoiler event warnings and restriction controls | 23 passed, 7 failed | 30 passed |
| Applicability quotation/possession | 22 passed, 5 failed | 27 passed |
| HTML extraction, streaming and linked-navigation controls | 58 passed, 26 failed | 84 passed |
| Five synthetic player scenarios in both discovery modes, including the natural Elite possessive | 18 passed, 2 failed | 20 passed |
| Strict PostgreSQL command truth fixture | 6 passed, 1 failed | 7 passed |

Some HTML negative cases fail before repair because the old reader lacks the new
closed-stream diagnostics; this does not mean the old reader executed source
scripts. Four added malicious role-assignment controls also pass, including
assignments embedded after ordinary gameplay prose. Independent peer inspection
approved the frozen identity/quotation/HTML changes and recomputed the enforced
semantic pins.

At least one genuinely retrieved public source passes all source-acceptance gates;
Frontier and QuestDuo provide independent examples across two games/publishers.
The same six-source panel changes from **0/6 to 1/6 accepted**; a separate
three-publisher Zelda recovery check accepts **1/3**. Final compiled rechecks
accept Frontier and QuestDuo again, each with one selected evidence passage.
The observation file retains all 23 bounded attempts, including intermediate
repairs and rechecks, across nine distinct URLs. These small selected samples
are not a production-wide success-rate benchmark.

| Final public source | HTTP | Extracted characters | Identity | Source CLEAR | Selected passages |
| --- | --- | --- | --- | --- | --- |
| [Frontier colonisation guide](https://www.elitedangerous.com/news/system-colonisation-guide) | 200 | 5,488 | Verified | Accept | 1 |
| [QuestDuo early Ocarina walkthrough](https://questduo.com/the-legend-of-zelda-ocarina-of-time/link-wakes-up-the-great-deku-tree-walkthrough/) | 200 | 13,026 | Verified | Accept | 1 |

This proves public acquisition through selected gameplay evidence. It does not
prove live generated-answer accuracy, live search-provider operation or production
readiness. Synthetic OAuth/MCP, host/backend discovery, Trinity and final-answer
regressions remain explicitly synthetic.

The full live provider gate remains **BLOCKED**: an authorized non-production
target serving the reviewed head, Gaming authentication, a configured search
credential and a bounded model-call authorization were not supplied. A local
provider credential's presence does not authorize spending it. Production flags,
Railway settings, production source records and credentials were not changed.

No semantic retrieval, embedding dependency, vector service or public schema was
added. The original 15-case selector and held-out lexical measurements remain
separate from public discovery and answer accuracy. The held-out paraphrase gap
is a follow-up; this remediation changes no lexical retrieval implementation.

Final validation measurements and the published revision are recorded with the
PR verification receipt. No merge or deployment is authorized by this report.
