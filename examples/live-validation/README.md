# Transient Gaming validation profiles

[profiles.json](profiles.json) defines the two reusable data-driven acceptance
cases for the single [Railway validation service](../../docs/LIVE_VALIDATION.md).
The positive Elite Dangerous case supplies Frontier's public system-colonisation
guide and asks for prerequisites and concrete starting steps with citations.
It requires verified game identity, admitted and selected guide evidence, complete
question coverage, measured intake, reasoning and final stages, bound Gaming
CLEAR Presentation v1 output, and structurally resolved citations. The negative
case supplies a Sekiro combat guide pinned to an immutable Git commit. It requires
a preserved source conflict with zero generation calls. Observe reachability and
coverage during execution.

[fixture-profiles.json](fixture-profiles.json) supplies controlled offline cases.
Its example HTTPS origin is a placeholder, not a deployed source host. If a public
fixture host is separately established, replace `fixtureOrigin`, question links
and `candidateUrls` consistently. Anonymous fixture routes must serve documents
directly, without redirects, authentication, signed parameters or private-network
addresses. The positive document is
`tests/fixtures/gaming-samurai-pc-clarification-guide.html`; the negative document
is `tests/fixtures/gaming-sekiro-conflict-guide.html`. The Elden Ring fixture
resolves the missing platform and three follow-up choices in the same workflow
with the selected evidence and acquisition allowances retained.

The existing v2 Gaming adapter forces transient storage, isolates the actor per
request, skips stored retrieval and denies ingestion. It preserves source compatibility, freshness,
answer integrity and citation protections. Unknown
current patch compatibility remains visibly qualified; a meaningful clarification
is recorded as its own outcome. Optional
`clarificationReplies` contains at most eight context patches; constraints remain
cumulative. Workflow identity, revision and idempotency keys are assigned by the
adapter, with normal service ownership and refinement fences preserved.

Observations contain sanitized acquisition, evidence selection, generation,
presentation binding and response construction. Missing hooks
remain unobserved. They contain no prompt, full source/answer, hidden reasoning or
secret. Bounded clarification counts and retention/revision invariants accompany
the positive result; a missing or failed measured stage cannot pass. The profiles
share one bounded run: USD 2, 32 provider requests, two
workflows, one concurrent provider request, ten minutes and zero automatic
retries. The v2 profile expects zero separate answer-audit requests. Historical
v1 receipts remain readable under their original audit contract. Live
readability and request alignment are reviewed by the operator from the existing
private delivered-answer artifact.
