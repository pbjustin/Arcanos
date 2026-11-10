# Structural procedure review follow-up

The [review finding](https://github.com/pbjustin/Arcanos/pull/1597#discussion_r4521436652)
was verified against PR head `99e4afeff243e8b239566d90a962d2e312d00645` on
November 10, 2026. The exact complete HTML row `Mechanic: system colonisation;
Value: optional` incorrectly satisfied both a starting-procedure request and a
prerequisite request. The earlier generic reward-row negative did not reproduce
this boundary because its fields did not meet the existing structural policy.

The permanent fixture uses the actual HTML extractor with authored source
material. Before the repair, its expanded 34-case request suite had eight
failures and 26 passes. Positive controls already passed; the failures identify
topic-only and borrowed procedure support. A malformed-unit regression added
during review brings the final suite to 35 cases.

The existing structural validity and exact lexical gates now run before field
access. Non-procedural requirements retain their existing behavior. Procedural
requirements additionally need a supported relationship in a field value, or a
literal same-record mechanic/value combination whose value begins a closed
start/requirement predicate. No relationship is borrowed from another record,
an independently named subject, a heading, caption or column label.

The temporary relationship check does not rewrite selected evidence. Positive
regressions verify original unit identities, text and citation URLs. Existing
partial/malformed record rejection, source authority, applicability, provenance,
CLEAR v7 and execution budgets remain binding. No extraction parser, structural
field alias, public schema or installed plugin change was made.

The final 35 request cases pass, including real-parser mechanic/value positives,
topic-only negatives, direct value claims, unrelated/negated predicates,
metadata/other-row laundering, malformed records and ordinary non-procedural
facts. Six focused suites pass 249 tests. An independent review exercised 16
additional authored cases and approved the bounded correction.

The reviewed CLEAR semantic digest is
`4210f1d359f11a01eb04cd761d5c7ff4963e6b6fecb089c5633e7cd7f0cd7b51`.
The retrieval-policy semantic digest remains
`731d44075dbf1699afde8b2da98321e452357a3477a01aa23df2597b2e34b59a`;
its follow-up changes are comments only. The native-preview checker keeps both
gates enabled. Broader final validation and the pushed SHA are recorded in the
PR description rather than rewriting earlier measurement receipts.

Final frozen-source validation passes 238 Gaming/honesty/import-boundary suites
with 8,543 tests and zero failures/skips. Seven guarded PostgreSQL suites pass
167 tests with zero failures/skips/open handles; the existing false-authority
controls remain 0/9. The fresh owned PostgreSQL 18.6 target used only a verified
loopback address and the guarded disposable database. Zero Gaming schemas
remained, and only that owned server was stopped. Build, type-check, lint (zero
errors, 77 existing warnings), documentation/index/local-link checks and diff
checks pass with Node 24.18.1/npm 11.16.0. GitHub CI completion is not awaited.

The PostgreSQL run kept execution HEAD `99e4afeff243e8b239566d90a962d2e312d00645`
and the uncommitted repaired source stable throughout. Its build-source digest
is `1db4ffee632c2c8753776ad83cc307a6932c3e28013b0959aad842e6dadf5e20`;
the changed CLEAR source bytes hash to
`a0bb7c1fc891e52c62d568422e8796c5b71f9f713561c12c1c66d8a21551aa13`.
Publication commits those reviewed changes after validation. These hashes bind
the execution snapshot; they do not represent live-provider or deployed proof.

The review's docstring warning reported five of 12 touched named functions
documented, against an 80 percent threshold. Missing helper documentation was
added, including all seven identified functions and the new extraction fixture
helper. Local TypeScript AST inspection found documentation on all 13 relevant
functions under the same approximation. This is source inspection, not a
renewed CodeRabbit coverage result; no new review round was requested.

Tests use deterministic external effects or the owned disposable PostgreSQL
target. This follow-up makes no provider calls, stores no sources and changes
no production settings. The repaired-head real-provider acceptance gate remains
blocked as described in the [delivery contract](delivery-contract.md).
