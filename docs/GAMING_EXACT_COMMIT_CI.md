# Gaming exact-commit mocked CI verification

This is an additional, manually dispatched verification lane. It does not
deploy an application or replace the existing CI/CD, branch-protection,
release, or stacked-preview admission checks.

## Dispatch contract

The previous `ci-cd.yml` dispatch declares no inputs. Its mock flags are actual
configuration, but candidate code executes on the runner, and coverage receives
Codecov access. Branch dispatch captures an event commit without accepting the
owner's fixed source SHA. The new
[dedicated workflow](../.github/workflows/gaming-exact-commit-verification.yml)
keeps that general pipeline unchanged.

| Input | Type | Required | Accepted value / default |
| --- | --- | --- | --- |
| `source_sha` | String | Yes | Exactly 40 lowercase hexadecimal characters; one of the two owner-authorized commits below; no default |
| `mocked` | Boolean | Yes | Must be explicitly `true`; default `false` fails admission |

The trusted controller rejects extra inputs, false or ambiguous mock values,
zero/short/uppercase/injected SHAs, other commits, forks, changed heads/bases,
closed/ready/merged PRs, reruns and dispatches outside owner `pbjustin` on
protected `main`. Both the actor and triggering actor must be that owner.
No deployment, publication, live-provider, environment or profile override is
supported. Changing this fixed authorization requires another reviewed change.

| PR | Authorized source | Expected base |
| --- | --- | --- |
| #1534 | `dc7e7fdd34fd3563653ecb224102c73c1696239e` | `codex/gaming-generic-foundation-1532` |
| #1535 | `0a6f0d4545a6c9e26fff81f9275d1fc2457bb470` | `codex/gaming-claim-corroboration-1532` |

Dispatch `--ref main` selects the trusted workflow, not the candidate branch.
Controller checkout uses the immutable workflow SHA. Only after repository,
protected-controller, draft-head and commit API validation does candidate
checkout use the exact validated `source_sha`. Trusted Git commands require
`git rev-parse HEAD` and `HEAD^{tree}` to equal the requested commit and the
repository API's tree before any candidate code runs. Both are logged and
recorded. Symlinks, submodules and unsafe archive paths fail closed.

## Isolation and execution

Permissions are only `contents:read` and `pull-requests:read`. No GitHub
deployment environment, production/provider secret, write token, OIDC or
registry publication permission is requested. Checkout credentials are not
persisted. The read token is used only by trusted admission and final status checks, never by
candidate code.

Dependency acquisition copies trusted-main manifests and the reviewed vendored
dependency into a fresh directory, requiring all candidate manifests/lockfile
to be byte-identical first. `npm ci --ignore-scripts --no-audit --no-fund` uses
empty user/global npm configuration, an empty HOME and the public registry.
Candidate npm configuration, source and hooks do not enter this networked stage.
Required managed proxy/CA transport may be retained for this trusted client;
GitHub, npm, provider and Railway credentials are excluded.

Candidate scripts execute only inside a local container based on a pinned
public Node image with Git, independently resolved to an immutable local image ID. Its
configuration is inspected before startup: network `none`, loopback-only DNS,
nonroot UID65532, dropped capabilities, no privilege escalation, read-only
root, no shared host PID/IPC/devices, no ports, no restart or Docker socket.
Only source/dependency archives and the trusted runner are mounted, read-only.
Writable scratch is bounded tmpfs; the working mount permits local tool
execution, including a fixed private `/work/tmp` for fixture executables,
while the `/tmp` mount is explicitly `noexec`. Both deny devices and setuid
behavior. An empty environment is replaced with fixed
synthetic mock settings and offline npm configuration. No runner token,
credential file, provider key, production runtime configuration or proxy is passed
to candidate execution. Tracked source may contain endpoint strings; kernel
network denial remains authoritative if candidate code
changes its own flags.

Limits are two CPUs, 8GiB RAM with no additional swap, 256 PIDs, 4GiB work
tmpfs, 512MiB temporary tmpfs, 30 minutes execution and 8MiB combined output.
Effective checks verify identity, runtime versions, mock environment, denied
external TCP/DNS and permitted local loopback before repository code. Candidate
output is saved as untrusted data; it is not streamed as GitHub workflow commands.
Container deletion is required on success and failure, including creation
failure. A generated ownership name is recorded before creation so cleanup
does not depend on the create command returning an ID. Inconclusive removal
fails verification and preserves that name for bounded orphan recovery.

The fixed profile runs offline dependency initialization, type-check, lint,
build, ten Gaming scope/identity/applicability/corroboration suites, stacked
preview contracts, native preview containment and static Railway validation.
The benchmark suite is additionally required for #1535. PostgreSQL, Redis,
Windows, live publishers, normal private-plugin OAuth, paid generation and
hosted Railway execution are outside this profile. No image is built or pushed
for application deployment; pulling the pinned public runner image is separate.

## Evidence and existing release gates

Retained artifacts bind actor/run/attempt, controller, requested and actual
source SHA/tree, canonical source archive and dependency archive hashes, pinned
runner image, effective containment, exit/failure and cleanup. Candidate logs
remain untrusted test-output evidence. A final trusted API check records that
the same exact PR head remains an open, unmerged draft, or fails the run.
A receipt is not a signed attestation
that arbitrary candidate-authored tests are honest.

Native GitHub run/check metadata belongs to the `main` controller SHA. Read-only
permissions cannot attach a status to the input source SHA. Consequently these
receipts do **not** satisfy the preview controller's existing per-head
`All Checks Complete` or the protected release workflow's full CI/CD requirement.
Do not spoof that job name or relax admission. Any compatibility change needs
separate review and authorization; full CI/hosted readiness remains distinct.

Repository Actions policy and full branch-protection settings could not be
inspected through the current integration (403). Their actual approval of this
new workflow is NOT VERIFIED. Local validation is not a hosted Actions result.

## Owner procedure after a separately approved merge

1. Complete required review/checks for this infrastructure PR and establish safe
   production-trigger holds before merging. A main merge can invoke existing
   registration/documentation workflows and ordinary CI; this repair does not
   disable or authorize them. Full production/native-trigger hold remains an
   independent prerequisite for that merge.
2. Merge only with separate owner authorization. Confirm the new workflow and
   trusted controller are on protected main and permitted by Actions policy.
3. Recheck both Gaming PRs remain open drafts at the exact approved heads, with
   unchanged bases. Check for equivalent existing verification runs, including
   queued/active/failed/cancelled runs. The workflow serializes concurrent runs
   but does not itself prevent all historical duplicate dispatches.
4. Separately authorize one verification per source, including bounded Actions
   usage. No old dispatch approval is treated as permission to execute this
   newly merged workflow automatically.
5. Only then, the explicit example commands are:

```bash
gh workflow run gaming-exact-commit-verification.yml --repo pbjustin/Arcanos --ref main --raw-field source_sha=dc7e7fdd34fd3563653ecb224102c73c1696239e --raw-field mocked=true
gh workflow run gaming-exact-commit-verification.yml --repo pbjustin/Arcanos --ref main --raw-field source_sha=0a6f0d4545a6c9e26fff81f9275d1fc2457bb470 --raw-field mocked=true
```

These commands were **not executed** while preparing the repair. Record each
run URL/attempt/input, actual checkout/tree, all outcomes and skips, containment
and cleanup; preserve failures without automatic retries or reruns. Confirm
both PRs remain drafts and production unchanged afterward. A newer controller
does not justify refreshing Gaming branches under this repair's authorization.

## Rollback

Stop dispatching this workflow. Cancel only an independently authorized active
verification if needed; its controller removes its owned local container on
failure. If creation/removal is inconclusive, inspect only the exact generated
name in `container-ownership.json` through the local Unix Docker socket. Verify
its ownership label, source, image and input mounts, then remove that exact
container ID and recheck absence. Preserve the failed receipt; do not prune
other containers or replay the verification. Runner loss/SIGKILL requires
disposable runner reclamation rather than a claimed successful cleanup receipt.
Revert this narrowly scoped infrastructure change through the normal
protected review process. Do not restore production controls, change Gaming
branches, replay expired runs or dispatch a replacement as part of rollback.
The original CI/CD workflow and release/preview admission rules are unchanged.
