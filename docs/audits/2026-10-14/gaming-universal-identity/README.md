# Universal Gaming identity verification

Baseline: reviewed PR #1542, `e24d5614748f39e25e27a0c062dfba2ea0adbb77`.
Target: `main`, `c8bb00ee000e3e188f17e1aa2b5e2893d0221fb8` at local verification.
At this original validation checkpoint, #1542 was still open and draft; its
branch was unchanged. It later merged as
`f34da2cc1565bd2105af4254cf41b0a9634afe9e`. See the
[post-merge integration record](post-merge-integration.md) for current evidence.

The [architecture and matrix](../../../GAMING_UNIVERSAL_IDENTITY.md) describe the
generic implementation and its limits. [validation.json](validation.json) binds
the frozen local source and fixtures by LF-normalized SHA-256. The canonical
CI/CD workflow emits a separate per-SHA receipt after publication; its run and
artifact are linked from the draft PR. This local receipt does not claim a
hosted result before that run completes.

## Reproduced defects and disposition

| Defect | Root cause and smallest correction | Regression evidence |
| --- | --- | --- |
| Unknown game with a generic acquired heading rejected | Positive body scope depended on registry alias detection; use full acquired identity independently of topic vocabulary. | Nine-game real-validator matrix, including unregistered Copperwind Loom; unchanged parent fails the new workflow cases. |
| Unknown subtitle collapsed to a known parent | Canonicalization scanned aliases inside longer titles; require exact canonicalization and preserve full suffixes. | Minecraft Moonbound, Features and Has Fallen controls; exact source lookup and wrong-edition tests. |
| Equivalent numeral title failed under a full heading | The metadata anchor used a literal title while the acquired body used comparable numerals; apply full comparable identity with only existing document-label suffixes. | III/3 in both directions, with title-only, different sequel and unknown subtitle negatives. |
| Ordinary words or topics self-promoted as games | Bare equality supplied identity without acquired game context; require explicit context for ambiguous names. | Heavy Weapons, Power Armor, Early Game, ordinary-word and acronym controls. |
| Exclusion/reference prose admitted under a matching title | An unconstrained copular predicate counted references as ownership; require affirmative game-domain predicates and preserve quoted/negated exclusions. | Actual acquired HTML exclusion, comparison and requested-game controls. |
| Official patch-page ownership lost under stricter proof | Existing valid release DOM lacked generic game-declaration prose; use its reviewed, independently parsed release records, retaining incomplete currentness. | 18 real resolver/adapter tests; malformed platform DOM remains refused. |
| Confirmed unknown edition rejected during worker refetch | Detector preserved the qualified title while the guard compared only the base game; compare exact base or exact base plus the bound approved edition. | Remastered and Definitive Edition approval/refetch/storage/no-URL lifecycle tests plus wrong-family/edition controls. |

No game was added to production registry data. No topic-specific game exception,
new service, identity cache, model parser, protocol shape, storage permission,
plugin identity, OAuth or distribution change was introduced. Internal CLEAR v3
requires reassessment of obsolete v1/v2 approvals before acquisition or writes.
Structured preview and benchmark fixtures now carry actual acquired game scope;
their negative labels, admission thresholds and effect boundaries remain intact.

## Local validation and remaining evidence gates

The final Gaming sweep passes 5,154 tests in 162 suites; one database suite and
nine tests are explicitly skipped locally. The final native preview import
boundary passes 410 tests and the compiled metrics check passes one test.
Type-check, lint (zero errors; 77 existing warnings),
build, static Railway compatibility, documentation links/indexes and diff checks
pass. The full local Windows result and the unchanged-main comparison are
recorded separately in the JSON receipt, including all failures and skips.

The six Windows receipt-path/symlink and ESM child-import failures reproduce on
unchanged main. They are not repaired as part of this Gaming capability. Hosted
Linux CI must establish their final-head disposition, and hosted PostgreSQL
suites supply the database evidence omitted locally. Earlier diagnostic runs
included in-scope failures repaired above, a changing preview pin, a missing
compiled prerequisite and Windows timing failures. The final full Windows run
passes 17,932 tests with nine failures and 165 skips. Isolated assistant-registry
tests pass; Bash startup and subprocess-tree timing failures also reproduce on
unchanged main. Their unchanged-main comparison and all failures remain
explicit in the receipt. No unrelated implementation or test was altered.
The first hosted PostgreSQL run at `e5c88eae` found a synthetic guide missing
independently scoped acquired identity. Its shared fixture now supplies that
scope while retaining the original recommendation; SQL-free acquisition tests
prove the original insufficient body remains refused and the strengthened body
still requires currentness verification. No production validator was relaxed.

[performance.json](performance.json) records 14 paired bounded validation cases,
45 adversarial cases and 18 official currentness cases. Measurements exclude
acquisition and provider time; they are observations, not production latency
claims. All external responses are explicitly synthetic. No live Gaming
workflow, provider acceptance, deployment or production database operation ran.

`DEPLOYED_SHA_UNVERIFIED` and `LIVE_ACCEPTANCE_NOT_RUN` remain. Production
readiness is blocked pending separately authorized runtime evidence. The draft
At this original checkpoint, the draft PR and unmerged parent dependency
remained for owner review. The parent has since merged; PR #1543 remains draft.
