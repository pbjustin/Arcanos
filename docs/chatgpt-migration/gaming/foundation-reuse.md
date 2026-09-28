# Reuse of the #1509 migration foundation

The second migration reuses the existing primitives without copying the Tutor
integration directory. Some reusable functions retain historical Tutor file
names; renaming them is unnecessary for this scoped migration.

| Foundation element | Gaming disposition |
| --- | --- |
| Private input ignore and commit guard | Existing repository-wide `.local-migration/` boundary already covers Gaming. |
| Capture, provenance and fingerprint | Reuse `captureBaseline`, `validateBaseline`, `baselineFingerprint`, `readSafeFile`, `verifyArtifact` from `scripts/tutor-migration.mjs` through a narrow Gaming CLI. |
| Credential and path checks | Reuse existing safe-content, size, traversal and symlink checks. |
| Private byte scanning | Extract product slug from the fixed Tutor scanner into `check-plugin-private-boundary.mjs`; Tutor keeps its fixed wrapper. |
| Existing public canonical instructions | Pin exact pre-existing Git blobs at reviewed paths. Exempt only identical bytes there; copies, modifications and staged-only leaks remain rejected. |
| Hashes and package fingerprint | Reuse pure `digest`, `packageFingerprint`, `assertArtifactDigest` from `scripts/tutor-package-core.mjs`. |
| Portable manifest schema | Reuse the pinned Agent Plugins schema already in `integrations/arcanos-tutor/schemas/`; do not duplicate it. |
| Deterministic composition | Preserve source-plus-safeguards method; later add a narrow Gaming composer after complete baseline approval. Tutor's composition implementation embeds pedagogy and reviewed Tutor hashes and is not appropriate wholesale. |
| App mapping | Gaming needs exactly its own app for backend execution. Tutor's optional single-app policy and app identity do not generalize. |
| Archive/release reconciliation | Reuse bounded member inventory/hash design; current Tutor archive code hardcodes Tutor layout/identity and must not certify Gaming. No actual Gaming archive exists yet. |
| Release evidence | Keep source, package, account, installed skill, OAuth, live reads, and durable writes separate. Gaming gates must be derived from its contract. |
| Served migration fixture | Existing pure migration-package core and success-only proof markers remain intact; the backend prerequisite adds a separately bounded Gaming component fixture. |
| Preview lifecycle | Reuse trusted exact-head controller, worker-first role identity, maintained verifier, supplemental head verifier and owned teardown. |

## Concrete second-consumer gaps

The private scanner's hardcoded Tutor directory was a small missing abstraction.
Gaming also has public canonical instruction paragraphs that predate the private
capture. The existing scanner would reject those unchanged public files. An
exact-path, exact-base-blob exemption preserves protection without treating the
same private bytes as safe everywhere.

The credential heuristic also mistook the public schema phrase “bearer
authentication” for a credential. A narrowly tested standalone-word exclusion
can admit that phrase while retaining rejection of token-shaped values,
credential assignments and JWTs. This does not authorize reading or packaging
any credential.

OAuth service exposure is a real backend prerequisite rather than migration
framework work. It is split so the migration does not accumulate undeployed
runtime changes. Product composition, app optionality, behavioral acceptance and
release identity remain Gaming-specific. This checkpoint demonstrates capture
and boundary reuse; it does not yet demonstrate a completed second migration.
