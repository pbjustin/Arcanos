# PR #1542 independent review correction

Reviewed starting head: `41ab1f2cc4722d9e7c70703f72c8d7e696691067`.
Unchanged comparison base: `c8bb00ee000e3e188f17e1aa2b5e2893d0221fb8`.
This supplement records one confirmed correction. The original
[validation receipt](validation.json), [incident evidence](incidents.json), and
[deployment correlation](deployment-identity.json) retain their historical scope
and fingerprints. They do not fingerprint the subsequent correction.

## P2: bare Heavy Gunner and Power Armor topics still rejected valid evidence

Location: `src/services/gamingGameDetection.ts`,
`isGamingAcquiredTopicTitle`, the exact-label alternative in `topicLabel`.

Reproduction: acquire the synthetic Fallout 76 article with title and primary
heading `Heavy Gunner` or `Power Armor`, and retain the affirmative acquired body
`In Fallout 76, ...`. The original PR head reports
`GAME_IDENTITY_UNVERIFIED` / `gaming.identity.independent_anchor_required`.
The actual hybrid-v2 candidate workflow consequently stays in discovery with
`evidenceSelected: false`, although the identical `Heavy Weapons` article reaches
the real Trinity orchestration using synthetic provider transport.

Root cause: the registry's closed vocabulary recognizes heavy/gunner/power/armor,
but the topic predicate still requires a guide/build/equipment marker or exactly
Early/Late Game. Bare role and armor section labels therefore cannot enter the
existing independently acquired body-scope identity path.

Disposition: resolved with exact `Heavy Gunner`, `Power Armor`, and British
`Power Armour` alternatives. Arbitrary vocabulary combinations do not gain an
extra acceptance path. Independent affirmative game scope, explicit acquired
game declarations, wrong-game contradictions, edition gates, provenance,
selection, storage policy, and answer audit remain enforced.

This is an incomplete in-scope repair of a pre-existing false rejection, rather
than a newly introduced regression. Identical reproduction fixtures against
untouched main fail all six identity/workflow assertions for Heavy Weapons,
Heavy Gunner, and Power Armor. At the initial PR head the two Heavy Weapons
controls pass and the four Gunner/Armor assertions fail. No tracked baseline
source was changed. The red logs and fixture SHA-256 receipts are retained in
the review workspace under
`local_artifacts/pr1542-final-review/identity-review/`.

## Regression coverage

The corrected identity and actual workflow suites pass **53 tests across two
suites**, with zero skips under Node **24.18.1** / npm **11.16.0**:

- `tests/gaming-source-acceptance-identity.test.ts`: bare-label successes;
  absent and comparison-only game references remain unverified; Fallout 4,
  Fallout 3, Fallout: New Vegas, and Nightreign remain rejected, including an
  otherwise matching Fallout 76 body with a contradictory acquired clause.
  Explicitly named games retain precedence over topic vocabulary. Existing
  Elden Ring, expansion, furniture, incomplete-record and late-conflict cases
  remain in the same suite.
- `tests/gaming-source-acceptance-workflow.integration.test.ts`: all Fallout 76
  heading variants exercise acquisition, candidate validation, coverage,
  selection, Trinity stages and bound CLEAR answer auditing. Missing and
  comparison-only anchors stop before provider invocation. Existing bounded
  recovery, idempotent replay and forbidden-write assertions remain active for
  the expanded positive and negative fixtures.

The production source semantic pin is synchronized in
`scripts/check-native-pr-preview-imports.mjs`; generated indexes follow the
reviewed source and test layout. The broader Gaming regression run passes
**146 suites / 4,464 tests**, with the **one PostgreSQL suite / nine tests
skipped** locally because no disposable database was configured. The source
preview boundary suite passes **410 tests**. Type-check, lint (zero errors,
77 existing warnings), full build, static Railway validation, documentation,
index, and staged commit-guard checks pass. The final-head handoff receipt records the
broader Gaming run, type-check, lint, build, static Railway checks, source and
compiled preview boundaries, documentation/index checks, exact pushed SHA,
fresh GitHub policy/check/thread state, and hosted CI results separately.

## Review and runtime boundaries

Independent review covered the complete original diff and affected production
identity, extraction, acquisition, selection, Trinity and workflow consumers.
No additional confirmed code, security, receipt or fixture-fingerprint defect
was found. Existing workflow suites cover stale/missing revisions, changed
idempotency payloads, actor isolation, concurrency, incomplete evidence and
failed generation/audits. Historical raw fixture hashes differ under Windows
CRLF checkout conversion; the original Git-blob fingerprints match the initial
head and are not semantic mismatches.

GitHub protection at review time requires strict `docs:check` and
`All Checks Complete`, plus conversation resolution. No approval count or
additional active ruleset was present. The opt-in sealed preview is not a
universal merge gate; preserving an unlabeled draft correctly skips it. The
owner must explicitly leave draft before executing a merge. The review does
not change draft state, merge, deploy, or grant release approval.

All acquired documents and provider responses in these tests remain synthetic.
The real orchestration and citation/evidence binding run, but provider semantic
judgment is mocked. Local skipped SQL cases are not database integration proof;
hosted PostgreSQL evidence is recorded separately at its own tested SHA.
Original publisher bodies remain unavailable. No live Gaming workflow,
persistent Gaming write, preview/production deployment, Railway mutation, or
secret/configuration change was performed. Retain
`DEPLOYED_SHA_UNVERIFIED` and `LIVE_ACCEPTANCE_NOT_RUN`; production recovery
cannot be inferred from successful synthetic tests or hosted CI.
