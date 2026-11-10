# Production Git identity

## Repair and verification contract

The reproduced gap is Docker stage scope: without `ARG RAILWAY_GIT_COMMIT_SHA`,
the `postbuild` receipt sees no SHA even if Railway later supplies one to the
container. `.dockerignore` also excludes `.git`; neither a runtime variable nor
a matching artifact digest establishes a Git checkout. These are separate from
deployment freshness and source-configuration drift.

The Dockerfile declares the argument before the application build, copies the
remaining measured inputs (`schemas`, `Dockerfile`, `railway.json`), and writes
the final receipt after dependency pruning. Inputs must be full 40-character
hexadecimal revisions (normalized to lowercase); malformed build references
fail without logging their contents.

With a valid supplied reference, the build fetches only that exact revision
from `https://github.com/pbjustin/Arcanos.git` into a temporary bare repository.
It compares the complete selected source path set and actual Git blob bytes,
then removes the temporary repository. A bounded proof retains raw commit/tree
objects, not source blobs, credentials, Git configuration, or `.git`. Runtime
hash verification ties the measured source to the commit's content-addressed
tree; the proof itself is included in the emitted artifact digest. A clean local
checkout remains supported. Both web and worker use the same existing reporter;
native contained previews still return before importing it.

| Evidence | Source status / reference result |
| --- | --- |
| Only matching platform build/runtime references | `unverified` / `matches_build_reference` |
| Valid Git objects, matching source and both references | `verified_git_source` / `matches_verified_git_source` |
| Missing reference or unavailable fetch/proof | No platform-only verification success |
| Conflicting valid references | `mismatch`, independently retained artifact comparison |
| Malformed runtime reference | `mismatch` / `invalid`, raw input withheld |
| Changed source, proof, receipt, or emitted artifact | Verification withheld; digest disagreements report `mismatch` |

This is source-to-commit evidence plus build-receipt artifact consistency, not
a signed CI attestation, proof of GitHub authorship, branch membership, release
authorization, dependency integrity, or current deployment freshness. It relies
on the trusted Docker builder/compiler to produce the artifact from those
inputs. A compromised builder or a runtime attacker able to rewrite every code
and receipt file is outside the receipt's trust boundary. No private signing key
or new attestation delivery service is introduced. Startup remains observational:
unverified/mismatch logs do not replace the protected-digest gate or stop service.
Builds without GitHub metadata or with unavailable public Git access continue
honestly unverified; this permits existing CLI/disposable deployment modes.

## Local validation and later production acceptance

Focused tests exercise real Git commit/tree objects and Docker builds without
`.git`, including matching/missing/malformed references, mismatches, path-set
changes, forged rehashed receipts, and artifact/proof tampering. Run
`node --test scripts/production-build-identity-docker.test.mjs` explicitly for
disposable local Docker evidence. The existing actual-application image fixture
also verifies the no-SHA fallback in a network-disabled container.

Local results are recorded in the draft PR. They do not establish a deployed
runtime fix. Under separate deployment authorization, require fresh build and
startup receipts for both service deployment IDs, matching exact references,
`verified_git_source`, and `matches_build_receipt`; independently check intended
release freshness. A rollback uses the previously approved immutable image and
its original receipt, not edited SHA metadata. No merge, deployment, restart,
or live configuration correction is part of this repair.

## Railway compatibility audit (2026-11-09)

Railway's [Dockerfile documentation](https://docs.railway.com/builds/dockerfiles#using-variables-at-build-time)
says injected build variables require an `ARG` declaration in the stage that
uses them. Its [variables reference](https://docs.railway.com/variables/reference#git-variables)
says Git variables, including `RAILWAY_GIT_COMMIT_SHA`, are supplied when a
deployment originates from a GitHub trigger. A runtime variable does not
retroactively populate an earlier Docker `RUN` or establish source provenance.
The documentation was read directly from the official `.md` URLs after the
Railway docs integration returned `pageFound: false` for its search results.

Read-only reinspection of the production service configurations confirmed:

| Service | Repository / branch | Builder | Configured source reference |
| --- | --- | --- | --- |
| ARCANOS V2 | `pbjustin/Arcanos` / `main` | `DOCKERFILE`, `Dockerfile`, V3 | `3fd305b37ba410cf21684a8fed7619a1ba180b48` |
| ARCANOS Worker | `pbjustin/Arcanos` / `main` | `DOCKERFILE`, `Dockerfile`, V3 | `3fd305b37ba410cf21684a8fed7619a1ba180b48` |

Neither service had staged configuration changes. Both listed a directly
configured `RAILWAY_GIT_COMMIT_SHA` variable name; its value and precedence were
not inspected. The latest deployment records contained `reason: redeploy`
(web, 2026-11-05 08:05 UTC) and `reason: deploy` (worker, 2026-11-05 06:38 UTC),
without `commitHash` or branch metadata. These records cannot independently
identify deployed source or explain who originally set the older source
reference. The retained reference names an October 12 UTC merge; the supplied
runtime diagnostic reference names a November 4 commit. Neither reference
proves that the deployed artifact was built from those bytes.

The service start overrides also differ from the repository Docker command:
web invokes `scripts/start-railway-service.mjs` directly; worker imports three
Notion compatibility modules before invoking that launcher. Both reach its
shared identity report. These live overrides bypass the repository's outer
`scripts/start-railway-service-with-integrity.mjs` protected-digest gate. This
configuration drift is separate from the build receipt's artifact comparison.

## Separate operator follow-up

Under separate authorization, inspect deployment source/snapshot history and
the origin of the explicitly configured Git variable; confirm whether the old
`source.commitSha` is an intentional pin or retained historical configuration.
Correct the source connection/pin and any manually maintained SHA only after
that evidence is established. Review the startup overrides against the canonical
integrity wrapper. Do not hardcode the current moving `main` SHA, automatically
repin production during a build, or infer deployment freshness from matching
reference strings. No live configuration was changed for this audit.
