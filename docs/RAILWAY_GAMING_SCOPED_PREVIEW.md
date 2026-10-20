# Trusted Gaming synthetic Railway preview

`GAMING_SCOPED_PREVIEW = NOT_RUN` until the separate owner-dispatched hosted
workflow completes verification, final deployment attestation and verified
cleanup. This infrastructure does not change frozen [PR #1558](https://github.com/pbjustin/Arcanos/pull/1558).
Its approved source is commit `1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262`, tree
`89f1eb0b988514d92ef9f82dd2f77bc356735b8b`. No merge, production promotion,
provider inference, Notion access or hosted execution is authorized by this document.

## Architecture and reuse

The [manual workflow](../.github/workflows/railway-gaming-preview.yml) runs the
[Gaming controller](../scripts/railway-gaming-preview.mjs) from its exact
protected-main revision. It has separate runners for authorization, secretless
build, static publication, deployment, credential-free verification, final
control-plane attestation and always-run cleanup. The final verdict requires
verification, final attestation and cleanup all to succeed.

The lane reuses the bounded Git object adapter, GitHub owner/main/CI readers,
Railway API transport and isolated-workspace authority checks from the
[historical stack](RAILWAY_STACKED_DRAFT_PREVIEW.md). Its historical PR allowlist,
disabled activation, workflow, Dockerfile and runtime remain unchanged. The
shared artifact implementation now has two fixed module-owned profiles; the
new [Gaming profile](../scripts/gaming-preview-build.mjs) does not accept a
candidate Dockerfile, arbitrary tooling path or caller-defined profile.

The existing [native verifier](../scripts/native-pr-preview-e2e.mjs) and
[MCP verifier](../scripts/gaming-mcp-preview-e2e.mjs) supply the combined
[Gaming verifier](../scripts/gaming-scoped-preview-e2e.mjs). Its trusted inventory
fixes all 63 native and 21 MCP request descriptors, including their bodies,
paths and timeouts. Missing, duplicated, modified or skipped required checks
fail. The full-platform default retains its 173 descriptors and Notion coverage.
Gaming never writes success to the full-platform status context.

## Admission and provenance

The workflow admits only an initial manual dispatch by owner `pbjustin`, with
the same event sender, repository `pbjustin/Arcanos`, `refs/heads/main` and exact
workflow reference. Deployment reruns are rejected; owner-only cleanup retries
retain the original run and ownership receipts. Owner permissions and protected main
are freshly read. PR #1558 must be open, non-draft, same-repository and target
main, with the exact frozen head/tree, approved current base and green terminal
CI. Source changes require a separately reviewed policy update. Labels and
ready-for-review events grant no Gaming deployment authority.

[Controller policy](../config/railway-gaming-preview-control.json) ships with
`enabled: false` and `target: null`. Merging this PR cannot provision anything.
The owner must separately approve the code, provision and audit a dedicated
target, and review the exact target policy on protected main before dispatch.
The existing production workflow's coordinated-writer hold remains unchanged;
an executable regression confirms a main CI completion cannot pass it. Recheck
that hold and deployment-trigger state before any separately approved merge.
The [scope policy](../config/railway-gaming-preview.json) permits hosted execution
only with a trusted controller-issued receipt; JSON and candidate CLI options
cannot issue that receipt.

Every dispatch authorizes exact controller/main/base, head, tree, source archive
SHA-256, target-policy SHA-256 and expiry (maximum two hours). Before each effect,
the controller refreshes admission and authority. The image binds the source
archive, six compiled output trees, pruned runtime dependency inventory, run,
target, lease and kernel launcher. The source archive and image tar are immutable
same-run artifacts. Publication verifies both again, loads the image as data,
requires an existing private owner GHCR package, and records the immutable
registry digest. GitHub OIDC provenance attestations cover the archive, image
tar and binding receipts. Deployment never uses a tag or Git-source build.

## Credentials and network boundaries

Candidate code executes only inside resource-limited build containers and the
isolated runtime. Online dependency fetching uses manifests and a lockfile with
scripts disabled. Candidate hooks, compilation and pruning run with BuildKit
`--network=none`. Fresh trusted tooling checks reviewed source and compiled
import graphs independently of candidate build tools. Candidate code receives
no GitHub write, Railway, production, Notion, AI-provider or data credentials.
Publication has package/OIDC authority but never starts candidate images.
Deployment and cleanup have only the dedicated Railway workspace credential.

The publisher reads private-package metadata through the fixed authenticated-owner
`GET /user/packages/container/arcanos-gaming-preview` endpoint. Its current
[endpoint-specific REST documentation](https://docs.github.com/en/rest/packages/packages#get-a-package-for-the-authenticated-user)
supports GitHub App installation tokens, and GitHub identifies
[`GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token)
as that token type. The existing ephemeral workflow token remains the only
publication credential. Exact package name, container type, owner `pbjustin`
and `visibility: private` must all match before Docker runs. A 401, 403 or 404
fails closed; there is no PAT fallback or anonymous-401 visibility shortcut.
Authenticated-owner resolution for the provisioned private package remains
`NOT_PROVEN` until a separately authorized protected-main preflight succeeds.

Railway's [outbound documentation](https://docs.railway.com/networking/outbound-networking)
describes outbound connectivity and static IPs; it does not establish a general
destination-deny firewall. Private networking is disabled in the isolated
environment. A trusted, root-owned [Linux amd64 launcher](../scripts/gaming-preview-network.c)
sets `no_new_privs` and an inherited seccomp filter before any candidate process.
It denies outbound connect, datagram/raw sockets, sendto/sendmsg/sendmmsg,
io_uring and process-injection bypass paths, and closes inherited descriptors.
Its first exec also supplies a fresh environment with only the fixed role and
Railway identity keys, removing credentials and Node preload options before
the trusted supervisor starts. The supervisor's original environment cannot
be recovered from its process environment by a candidate child.
Local socketpair IPC remains available for child startup. Inbound TCP listeners
and replies on accepted sockets remain available. Startup performs packet-free
negative syscall probes; the trusted runtime independently checks the kernel
state and launcher digest. Unsupported kernels or blocked filter installation
fail startup. Expiry terminates the child, with bounded forced termination.

This is an inherited process/kernel egress boundary, not proof of a Railway
provider firewall or a general defense against kernel/container escapes.
Independent Linux tests exercise TCP/UDP/DNS denial, child inheritance and
inbound HTTP. Hosted compatibility remains unproven until an authorized run.
Application mocks alone are not claimed as network-isolation proof.

Controller egress legitimately reaches fixed GitHub/Railway APIs and attested
preview readiness endpoints. Publication reaches GitHub/GHCR. The verifier
has no management credentials and sends only the fixed requests to two
control-plane-bound preview origins, with redirects forbidden and credentials
omitted. Git checkouts in that runner are evidence only. A digest passed directly
from the trusted deploy job authenticates the downloaded deployment receipt;
the verifier does not trust a digest inside its own input artifact.

The runtime still contains the frozen sealed application's broad route surface.
The Gaming inventory never selects its Notion canary. Outbound kernel denial
prevents provider connectivity even if a public caller requests an excluded
fixture. No actual Notion connectivity test is used to establish this boundary.
No production database, Redis, durable ingestion, volumes, shared variables,
deployment triggers or arbitrary start/predeploy commands are admitted.
Private registry pull credentials must match an owner-audited fingerprint;
their pull-only privileges and expiry require separate owner verification.

## Execution, failure and cleanup

The isolated workspace must contain only the reviewed preview project, two
service definitions and one idle template environment. Existing production
workspace/project IDs are forbidden. The worker deploys first; web cannot
start until the worker's sole immutable deployment is successful and passive.
Both roles must report exact-SHA readiness, expected hosts and bounded health.
The controller rechecks both sole-active deployments before emitting its receipt
and independently reattests them after all 84 verification requests.

Request limits remain five seconds each, 60 seconds combined, 64 KiB per body,
512 KiB combined, with the MCP phase's stricter 128 KiB aggregate limit. The
second phase receives only remaining time. Abort and response reads are bounded.
No Notion selector, live source retrieval, real inference or durable storage
mutation is in the inventory. Nested proofs cover synthetic guide/build
acceptance, acquisition/extraction, identity/editions, CLEAR, Trinity honesty,
injection, provenance, citations, auth denials and request/cancellation bounds.

The controller persists creation intent before provisioning and journals exact
ownership before further effects. Lost create responses recover only a unique,
idle environment matching the exact run-derived name, source template and
project. Committed ownership patches bind image, source and controller. Failures
attempt immediate cleanup; the separate cleanup job runs even after failed
verification/attestation and may delete owned resources after lease expiry.
Ambiguous ownership fails closed. Forced runner loss or unavailable control
plane can require owner recovery; no workflow can guarantee deletion during an
external outage. Such a run cannot pass.

Cleanup requires absence by exact UUID and name across complete, unfiltered
root and project Railway control-plane inventories. The pinned official CLI
[schema](https://github.com/railwayapp/cli/blob/dc804165e0cc976036d0f4f328cd564033bdc3b5/src/gql/schema.json)
defines `Query.environment` as non-null, so a fabricated null-resource
contract is not used. Soft-deletion tombstones, queued deletion still exposed
in either inventory, incomplete pagination and API errors cannot pass. A former URL returning 404 is supplementary,
never deletion proof. Bounded receipts retain codes/identities rather than raw
logs or sensitive values; Actions v4 artifacts are retained for 30 days. Preserve
the run and provenance bundles in the owner's evidence archive before expiry.

## Owner activation procedure

1. Obtain independent infrastructure/security reviews and explicitly approve
   protected-main deployment. Do not merge or activate as an implicit follow-up.
2. Separately authorize a trusted bootstrap publication to create the private
   `ghcr.io/pbjustin/arcanos-gaming-preview` package; this workflow requires it
   to exist already. Inspect its exact owner, name, container type and private
   visibility. In the package's **Manage Actions access**, grant
   `pbjustin/Arcanos` **Write** access, as described in GitHub's
   [workflow package access guidance](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#ensuring-workflow-access-to-your-package).
   Use a separate expiring pull-only identity granted read access only to this
   package for Railway; never reuse the workflow publication token.
   Provision a new isolated Railway workspace with only a dedicated preview
   project, idle template and two services. Disable native/bot/focused PR deploys,
   private networking, volumes, triggers, databases and shared variables. Audit
   the workspace-only API token and expiring private-image pull-only credential.
   Review exact target IDs, region, CPU/memory limits and credential fingerprint
   in the controller policy. Enable that reviewed policy on protected main only
   with separate owner approval. Configure the dedicated GitHub environment
   `railway-gaming-preview` and `RAILWAY_GAMING_PREVIEW_API_TOKEN`. Its deployment
   branch policy must allow main only; any approval must cover teardown too.
3. Freshly read PR #1558, protected main and required CI. Confirm the intended
   frozen head/tree again; keep the PR non-draft and without `railway-preview`.
   The broad lifecycle now refuses #1558 even if accidentally labeled or marked
   ready. Retain the exact current main/base/controller SHA from this refresh.
4. From a clean protected-main checkout, fetch the frozen SHA as data. Compute
   `sourceArchiveSha256` with
   `new GitReadAdapter({cwd:process.cwd(),canonicalArchive:true}).archiveSha256(headSha)`
   (Git archive with `core.autocrlf=false`, independent of Windows checkout settings) and
   `targetSha256` with SHA-256 of `JSON.stringify(policy.target)` using the
   reviewed controller policy. Prepare this exact JSON, replacing placeholders:

   ```json
   {"version":1,"controllerSha":"CURRENT_PROTECTED_MAIN_SHA","mainSha":"CURRENT_PROTECTED_MAIN_SHA","baseSha":"CURRENT_PROTECTED_MAIN_SHA","headSha":"1c1e7d0f4c8f4e62fd7117e28efd0d8d7c415262","treeSha":"89f1eb0b988514d92ef9f82dd2f77bc356735b8b","sourceArchiveSha256":"ARCHIVE_SHA256","targetSha256":"REVIEWED_TARGET_SHA256","expiresAt":"FRESH_UTC_ISO_TIMESTAMP_WITH_MILLISECONDS"}
   ```

5. Explicitly authorize that SHA and isolated target, then dispatch as `pbjustin`:

   ```powershell
   gh workflow run railway-gaming-preview.yml --repo pbjustin/Arcanos --ref main --raw-field "authorization_json=$(Get-Content -Raw ./gaming-owner-authorization.json)"
   ```

6. Inspect authorization, build/source/image provenance, worker-first deployment,
   all 84 executed IDs, final identity attestation and control-plane cleanup
   artifacts from that one run. Do not rerun an old dispatch; refresh authorization.
   The final result is `PASS` only when verification, reattestation and cleanup
   succeed; denied admission is `NOT_RUN`, and any admitted-run failure is `FAIL`.
7. If teardown fails, retain ownership/creation receipts, inspect exact resources
   and use the trusted cleanup command in the same reviewed owner context. Do
   not delete ambiguous or unrelated resources. Require inventory and exact-ID
   absence before closing the incident. The owner may retry only the cleanup job
   with `gh api -X POST repos/pbjustin/Arcanos/actions/jobs/FAILED_CLEANUP_JOB_ID/rerun`.
   It retains the original run/controller/receipts; replaying deployment remains
   prohibited. A missing ownership receipt requires manual owner investigation.

Hosted synthetic component proof does not establish live external-source
acceptance, actual model-generated gameplay answers, normal-route full provider
integration, production readiness or permission to merge. Those remain separate.

## Validation

[Infrastructure CI](../.github/workflows/gaming-preview-infrastructure-checks.yml)
runs mocked admission, provenance, publication, failure/recovery, cleanup,
inventory, bounds and Linux kernel tests. Its separate secretless artifact smoke
build has no publication or Railway authority.

Local image-smoke containers use the admitted maximum of one CPU, 512 MiB of
memory and 64 processes per role. The verifier retains its five-second request,
60-second aggregate and existing response-size limits; these resource caps do
not change any assertion or timeout threshold.

The frozen candidate's existing
assembled-application test executes all 84 cases offline while independently
checking its HTTP/HTTPS/fetch/Notion seams. Full-platform descriptor regression
and the historical stack's tests remain separate. Record actual outcomes and
review verdicts against the final infrastructure SHA; this guide is not a run
receipt.
