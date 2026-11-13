# Frontier guide-to-answer diagnosis

Base: `2df6e6a0fb409aaa42e1b5f687ea2622c8dde560`. The
[sanitized acquisition receipt](frontier-acquisition.json) distinguishes actual
publisher acquisition from deterministic replay and model execution. No source
body, player identifier, authentication material or production log is published.

The supplied failure was reproduced through the normal protected HTTPS reader,
current resolver v13 and deterministic source CLEAR v7. The publisher returned
HTTP 200; independent game identity passed; source CLEAR accepted the article at
4.1. Its 5,488 extracted characters hash to
`7b650756e8a6f76016102e13a350d0c4b1ef5cdfe3a75f0977e7b8d5d5963367`,
matching the retained #1595 article-text capture. This is actual acquired public
material, not an authored fixture. The current acquisition's complete raw page
was inspected by the resolver; only its bounded diagnostic prefix was retained.

## What survives extraction

All 22 nonempty article paragraphs survive verbatim in the normalized selected
article. The article contains 26 paragraph elements; four are empty. Opening,
registration, construction, expansion, rewards and closing sections remain. The
selected text omits unrelated linked news cards. The receipt binds paragraph
lengths and hashes without distributing the article.

The acquired guide supports these starting facts:

- Use the station-services colonisation contact and its galaxy-map selection.
- Choose an unpopulated destination within the guide's stated 15-light-year
  radius, then select the initial station/outpost type.
- Registration costs credits; the article makes the amount depend on the chosen
  structure. It establishes a 24-hour claim reservation.
- Travel to the chosen system and deploy the beacon at its assigned position
  through the colonisation suite, described as present on every ship.
- Supply mined and purchased commodities for construction. The article describes
  a fixed delivery period and an in-game prompt for obtaining needed goods; it
  does not establish a universal credit amount or exact commodity quantities.

These are the article's published mechanics, not verified current-patch facts.
Its February 2025 publication does not prove November 2026 applicability.

## Why extraction is partial

The acquired decoded HTML is approximately 2.84 MB. A large embedded Nuxt state
script exceeds the existing 262,144-byte per-JSON-script inspection ceiling; even
the retained prefix contains more than 850,000 characters of that script. This
produces `extraction_budget_exhausted`. No supported structured gameplay record
is found. The separate retained raw preview is capped at 1,048,576 characters and
correctly reports `raw_preview` truncation.

The visible-HTML security scan and article selection still run on the complete
accepted response. The ordinary article prose survives independently of the
unsupported structured state. Neither the raw preview cap nor the JSON warning
removed the starting procedure. No parser change or acquisition-budget increase
is justified by this reproduction. Partial remains visible; it does not grant
durable storage or current-patch authority.

## Exact failing transition

Acquisition and acceptance admit four overlapping article records of
1,671/1,689/1,776/921 characters. Each receives the existing 0.25 relevance floor.
All four survive passage projection; projected lengths are
807/709/722/749 characters, with combined score 0.5125 each. No record is lost to
rank truncation or formatting.

The old request parser creates two mandatory requirements:

| Requirement | Required lexical terms |
| --- | --- |
| Requested topic 1 | `prerequisites` |
| Requested topic 2 | `concrete`, `cite`, `sources` |

Its focus terms also retain `started` and `including`. The article establishes
requirements and a starting procedure using ordinary procedural prose, without
the literal word `prerequisites`. Citation/presentation instructions incorrectly
become gameplay requirements. Every projected passage scores zero against both
constructed requirements. The complete-coverage selector therefore returns the
empty set before formatting, and the later hybrid coverage assessment receives
no evidence. Trinity is correctly withheld from that empty selection.

This reproduction attributes the failure to request interpretation and coverage
selection. It does not establish a Frontier extraction defect. It also does not
justify removing independent identity, applicability, CLEAR, source-wide scope,
closed citation binding or the same-passage support rule for factual clauses.

## Evidence boundaries

After the bounded interpretation repair, the same 5,488-character article yields
four admitted/projected records and two selected passages. Prerequisites and
starting procedure remain independent requirements, each anchored to the exact
gameplay topic and a matching acquired grammatical relationship. Both pass;
`coverageSatisfied` is true and `missingCoverage` is empty. The final compact
context uses 1,886 characters within the unchanged 5,000-character limit.

The nine selected sentences bind exactly, in source order, to the acquired
article. One selected passage is an existing noncontiguous sentence projection;
it is not represented as one continuous publisher quotation. The receipt records
each supporting span and hash. The citation URL and acquired revision binding
remain unchanged. These measurements establish passage-to-source binding, not
the accuracy of unexecuted generated claims or citations.

The short starting question also accepts the same freshly acquired document in
the acquisition process, selects one passage and passes coverage with zero extra
fetches. The final frozen code replays the real acquired records separately,
retains two passages for the complete question and passes all span checks. Its
semantic digests are recorded; replay does not renew workflow authority or TTL.

The receipt records before/after source components separately. Deterministic
selection timings use 31 selections after three warmups of one already acquired
record snapshot; they are not end-to-end request or acquisition percentiles.
Public acquisitions are individual samples. The instrumented after acquisition
also ran those selections, so its wall time is not directly comparable with the
uninstrumented before sample. No live Trinity model, authenticated
installed-plugin request or user-facing generated answer is represented by
source-component acceptance.
