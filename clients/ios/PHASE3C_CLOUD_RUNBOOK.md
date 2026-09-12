# Phase 3C from Windows: cloud Apple builds and isolated iPhone validation

This path uses GitHub-hosted macOS to build the existing iPhone app, then a
separately authorized TestFlight upload to install its fixture configuration on
an authorized iPhone. Owning a Mac is not required. Windows/WSL tests, a cloud
Simulator, signing, TestFlight processing and physical observations remain
separate evidence. No additional CI vendor, recovery engine or demonstration app
is introduced.

Read the [device runbook](PHASE3C_DEVICE_RUNBOOK.md) for the full physical and
confirmation procedures. The cloud path replaces its local-Mac build/install
prerequisite; it does not replace those observations. Live ARCANOS pairing,
Gateway, provider, Local Agent and Railway checks remain **NOT RUN** and require
separate authorization. Neither app startup nor a fixture failure may contact
those services.

## Revision and publication boundaries

The Phase 3C tooling began at merged Phase 3B commit
`4f3652ed4397e8b7de8891696ea6160d4cd51af2`. Record current HEAD, source hashes and
working-tree status; this historical baseline is not proof that a later overlay
is committed or that GitHub has it. A local commit does not publish a workflow.

Before any cloud run, the reviewed code and workflow must be published through
an explicitly authorized repository change. This runbook does not authorize a
push, PR, merge, Apple account mutation, signing-secret installation or upload.
Do not dispatch the existing workflow and attribute its result to unpublished
local changes. GitHub manual workflows must exist on the default branch before
dispatch: [manual workflow requirements](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

The distribution workflow further restricts dispatch to `main` and requires the
full 40-character SHA to equal the selected workflow revision. This prevents
signing an arbitrary PR ref. If `main` advances, use the newly reviewed revision
and rerun validation; do not change the workflow to execute unreviewed code with
signing secrets.

Read-only repository metadata inspected during 2026-09-12 UTC preparation found
the existing iOS Client workflow, but no configured iOS/signing/TestFlight
environments. No environment or signing secret was created. The new workflow
files in the local overlay must still pass review and authorized publication;
their presence on disk does not make them dispatchable on GitHub.

## Reused target, isolation and toolchain

| Item | Selected value or required check |
| --- | --- |
| Project | `clients/ios/ArcanosVoice/ArcanosVoice.xcodeproj` |
| Application target | `ArcanosVoice`, including its existing five App Intents |
| Ordinary scheme/configurations | `ArcanosVoice`, `Debug` and `Release`; compile only during isolated validation |
| Fixture scheme/configuration | `ArcanosVoice-HardwareValidation`, `HardwareValidation` |
| Deployment target | iOS 18.0; no minimum-version increase |
| Package | Local `../ArcanosKit`; no third-party Swift package dependency |
| Cloud runner | `macos-15`, explicit `/Applications/Xcode_26.3.app/Contents/Developer` |
| Selected Apple SDK baseline | Xcode 26.3 with iOS SDK 26.2; record actual installed build and Swift version every run |
| App identity | `org.arcanos.voice.hardware-validation`, displayed as `ARCANOS Fixtures` |
| Storage | `ArcanosHardwareValidation-v1` Application Support directory and `org.arcanos.voice.hardware-validation.credentials.v1` Keychain service |
| Gateway | In-process durable fixture at a reserved `.invalid` logical origin; no sockets, DNS, HTTPS server or live transport |
| Apple components | Real system Keychain and real `LocalAI` provider, with actual availability checks |

The selected versions are listed in the
[GitHub macOS 15 runner image](https://github.com/actions/runner-images/blob/main/images/macos/macos-15-Readme.md),
inspected on 2026-09-12 UTC. That rolling image also lists iOS 26.2 Simulator
runtimes. The workflow must fail clearly if the selected Xcode installation,
SDK or compatible runtime disappears; runner documentation is not a successful
execution record. Do not fall back silently to the runner's default Xcode.

`ARCANOS_HARDWARE_VALIDATION` selects the existing shipping composition before
preference restoration or credential lookup. Ordinary Debug/Release exclude the
hardware adapters. The fixture app rejects a mismatched bundle identity and
does not offer live pairing controls. A persisted fixture mode cannot enable a
live Gateway. The local-only guard rejects and counts attempted remote fallback.

The fixed fixture bundle must belong to the operator's Apple team. Reserve it
as an explicit App ID. If it is unavailable, signing is **BLOCKED** pending a
reviewed, consistent fixture-only bundle/guard/profile change. There is no CI
bundle override and no fallback to shipping `org.arcanos.voice`. Do not add App
Groups, a shared Keychain group, background listeners, push entitlements or ATS
exceptions to solve signing or runtime problems.

## Secretless cloud validation

Use [ios-phase3c.yml](../../.github/workflows/ios-phase3c.yml) after authorized
publication. It is also reused as the prerequisite of the protected distribution
workflow. PR validation has read-only repository permission, no signing
environment and no Apple credentials. It must not use `pull_request_target`,
inherit environment secrets, deploy a backend or run a live integration proof.

The cloud check records the exact checkout, Xcode/Swift/SDK inventory and source
manifest; resolves the local package; runs Apple-platform package tests;
compiles the actual app configurations; and checks fixture-source exclusion and
packaged metadata. The existing [iOS Client workflow](../../.github/workflows/ios-client.yml)
retains its separate process/loopback synthetic recovery proofs. Read individual
results rather than treating an overall workflow badge as all evidence levels.

The Simulator procedure installs and launches only HardwareValidation. Its
automated app entry uses the same session, router, file persistence and recovery
composition. It coordinates acceptance, app-process termination, a new app
process and authoritative fixture completion/readback. Compare original and
restored operation/job IDs and per-job submission/execution counts. Direct
app automation is not a spoken App Intent invocation. Compiled App Intents
metadata establishes packaging only; actual Siri and Vocal Shortcut invocation
remain physical tests.

Review sanitized JSON evidence and bounded build/test diagnostics. Record a
missing runtime as **BLOCKED**, an attempted build/runtime assertion violation
as **FAIL**, and any unattempted later stage as **NOT RUN**. An unsigned
Simulator app cannot be installed on an iPhone or distributed through TestFlight.
Use `cloud-summary.json` for the expanded A-K cloud/device matrix. The older
`cloud-apple/report.json` retains the device runbook's A-G schema, while
`cloud-simulator/report.json` describes its own installed-app scope. Do not
compare a letter across these schemas without checking its definition.

## Apple account and signing setup from Windows

These are future operator actions in Apple/GitHub account interfaces, not actions
performed during tooling preparation. Keep all private material out of chat,
Git, screenshots, command history and downloadable CI artifacts.

1. Have the Account Holder verify active Apple Developer Program membership,
   account access and current agreements. App Store Connect requires its own app
   record before upload. In the browser, register the explicit fixture App ID,
   then create an iOS app record with that exact bundle, an available validation
   name, primary language and unique SKU. Limit app access to authorized testers
   and maintainers. [Apple app-record setup](https://developer.apple.com/help/app-store-connect/create-an-app-record/add-a-new-app).
2. Obtain an authorized Apple Distribution signing identity including its
   private key as an encrypted PKCS#12 (`.p12`), and its password, through the
   team's secure store. A downloaded `.cer` alone does not contain the private
   key. Do not rotate or revoke an existing production identity for this test.
3. If no identity exists, the account administrator creates one specifically
   authorized for this pipeline. Apple's documented CSR GUI uses a Mac; a
   Windows/WSL OpenSSL CSR can instead keep the key local while only its public
   CSR is submitted in the Developer portal. This alternative is prepared, not
   validated with an Apple-issued certificate during this task.
4. In Certificates, Identifiers & Profiles, create an App Store Connect
   distribution profile for the explicit fixture App ID and the selected
   distribution certificate. Download it to protected local storage. This is
   manual provisioning: CI does not create profiles or request account-wide
   automatic provisioning. [Apple profile setup](https://developer.apple.com/help/account/provisioning-profiles/create-an-app-store-provisioning-profile).
5. For a later upload, the Account Holder enables App Store Connect API access;
   an authorized administrator creates a role-limited team API key with the
   required upload permission. Team API keys are not restricted to one app, so
   limit their role and keep them solely in the upload environment. Capture the
   issuer ID, key ID and downloaded private key through secure account storage.
   [Apple API-key setup and scope](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api).

For step 3, run these only in a new access-restricted directory outside every
repository, with OpenSSL installed by the operator. Enter passwords only at the
interactive prompts; do not supply a literal password argument. The CSR prompts
for owner details, which are not validation evidence:

```sh
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
  -aes-256-cbc -out phase3c-signing-key.pem
openssl req -new -sha256 -key phase3c-signing-key.pem \
  -out phase3c-signing.certSigningRequest
```

After the administrator submits that CSR for an Apple Distribution certificate
and downloads the issued DER certificate as `phase3c-distribution.cer`:

```sh
openssl x509 -inform DER -in phase3c-distribution.cer \
  -out phase3c-distribution.pem
openssl pkcs12 -export -inkey phase3c-signing-key.pem \
  -in phase3c-distribution.pem -out phase3c-distribution.p12
```

Use a new name if any file already exists. Store the encrypted key, PKCS#12 and
password in the approved secret store; neither the private key nor password
belongs in the CSR upload. The commands use documented
[OpenSSL encrypted key generation](https://docs.openssl.org/3.0/man1/openssl-genpkey/),
[CSR generation](https://docs.openssl.org/3.0/man1/openssl-req/) and
[PKCS#12 export](https://docs.openssl.org/3.0/man1/openssl-pkcs12/).
Apple's [CSR instructions](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
describe the portal prerequisite; the cloud import/signature verification still
has to establish that the resulting certificate and private key work together.

## Protected GitHub environments and secret references

Before adding secrets, a repository administrator creates both environments
below in Settings > Environments, restricts deployment branches to `main`, adds
required reviewers, prevents self-review where supported, and disables approval
bypass. Protect changes to the workflows and their scripts through repository
review rules. Verify the repository plan supports the required protections;
missing protection is a blocker, not permission to put secrets in a PR job.
GitHub environment secrets become available only after configured protection
rules pass: [environment protections](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

| Environment | Purpose |
| --- | --- |
| `ios-hardware-signing` | Manually approved archive/export with no App Store Connect upload |
| `ios-hardware-testflight` | Separately approved archive/export and explicitly authorized TestFlight upload |

Use the environment **Add secret** interface, never chat. Base64 is a transport
encoding, not encryption; prepare encoded values locally without printing them
to a shared terminal/log. Do not place these at repository scope. The upload
environment needs its own signing references in addition to its upload key.

| Secret name | Purpose and environment |
| --- | --- |
| `IOS_SIGNING_P12_BASE64` | Encoded encrypted distribution identity; both protected environments |
| `IOS_SIGNING_P12_PASSWORD` | Password to import that identity; both environments |
| `IOS_PROVISIONING_PROFILE_BASE64` | Encoded explicit fixture App Store Connect profile; both environments |
| `IOS_TEAM_ID` | Expected Apple team binding; both environments |
| `ASC_KEY_ID` | App Store Connect upload API key identifier; upload environment only |
| `ASC_ISSUER_ID` | Issuer for that team API key; upload environment only |
| `ASC_PRIVATE_KEY_BASE64` | Encoded App Store Connect API private key; upload environment only |

The protected upload environment also requires the non-secret variable
`IOS_USES_NON_EXEMPT_ENCRYPTION`: `true` or `false`, set only after the account
operator reviews the build's actual encryption use. The script writes that
reviewed value into the build's compliance metadata. This variable is a
declaration, not an automatic legal determination; any required supporting
documentation still belongs in App Store Connect.

Do not add Gateway tokens, production pairing credentials, Apple account
passwords or session cookies. Missing signing material produces **SIGNING NOT
RUN**; it cannot produce a signed-archive PASS. No external signing service is
required. Use only disposable GitHub-hosted macOS VMs; the script intentionally
does not support a persistent self-hosted machine whose credential cleanup
would require separate policy and verification.

## Protected archive, export and future upload

The workflow is
[ios-hardware-distribution.yml](../../.github/workflows/ios-hardware-distribution.yml),
named **iOS Hardware Validation Distribution**, backed by the provider-neutral
[phase3c_signing.py](scripts/phase3c_signing.py). Its default mode is `archive`.
After publication and authorization, open GitHub Actions, select that workflow,
choose **Run workflow**, choose protected `main`, set `expected_sha` to the full
current reviewed SHA and `build_number` to a fresh Apple build version (1-9999
or the validated dotted form), then select `mode`. Do not approve an
upload while merely checking compilation.

The secretless validation prerequisite must pass for the same SHA before a
protected signing job is eligible. Review that evidence and the requested SHA,
configuration and mode at the environment approval gate. Archive mode uses
`ios-hardware-signing`; it imports the provided identity into an isolated runner
Keychain, validates profile/bundle/team/expiry/distribution constraints, archives
HardwareValidation for generic iOS, exports for App Store Connect and validates
the resulting signature, identity, entitlements and revision metadata.

The IPA and archive exist only within that ephemeral job. An installable IPA
contains `embedded.mobileprovision`, so this pipeline does **not** publish it as
a GitHub download artifact. It publishes only sanitized status/provenance JSON.
Do not upload the whole archive, export directory, runner Keychain, `.xcresult`
from a secret-bearing step, provisioning profile or raw signing logs. Destruction
of the disposable runner is the credential-lifetime boundary; do not work around
cleanup controls or run this path on a persistent worker.

For an explicitly authorized later publication, dispatch mode `upload` with
`authorize_upload` enabled. The separate `ios-hardware-testflight` approval is
required. That job rebuilds and signs the validated SHA, then submits from the
same ephemeral runner using the API credential; it does not retrieve an IPA
from an untrusted PR artifact. Different signing timestamps can change binary
hashes between archive and upload runs: retain each run's own provenance.

Local signature/export validation is not App Store Connect acceptance. Apple
processes an upload before a build becomes available. Confirm the actual build
status and SHA/build-number mapping in App Store Connect before marking upload
or installation successful. [Apple upload and processing behavior](https://developer.apple.com/help/app-store-connect/manage-builds/upload-builds).

## TestFlight prerequisites and installation

Review app packaging before enabling upload. The original project did not
contain an AppIcon catalog; HardwareValidation now includes a distinct
`ValidationAppIcon` asset. Check its reviewed artwork and compiled resource
metadata before claiming TestFlight readiness. The ordinary shipping build does
not select the validation icon.
Apple documents an asset-catalog icon path including a 1024-pixel iOS image:
[app-icon packaging](https://developer.apple.com/documentation/xcode/configuring-your-app-icon).
Do not bypass a missing-icon gate or call a successful unsigned build a valid
App Store binary. Also verify version/build numbers, fixture display name,
privacy manifest, matching explicit profile and distribution entitlements.

An authorized account operator must review the actual export-compliance
questions for this build before setting `IOS_USES_NON_EXEMPT_ENCRYPTION` in the
protected upload environment. Do not guess a legal declaration or hard-code an
exemption merely to skip Apple's processing gate. Record missing compliance as
**BLOCKED** until the declaration and any required account documentation are
resolved:
[beta export-compliance procedure](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-export-compliance-information-for-beta-builds).

After the authorized upload is processed, create an internal TestFlight group
with automatic distribution disabled. Add only the authorized App Store Connect
users with access to this fixture app, manually select the reviewed build, and
provide synthetic-only test instructions. The owner accepts the invitation in
TestFlight on the iPhone and installs `ARCANOS Fixtures`; no USB connection to
the Windows PC is necessary. Internal testing and external beta review are
different distribution paths; this procedure does not enable external testers
or a public link. [Internal tester setup](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers).

## Physical iPhone procedure after installation

Start with the phone model and iOS version/build, TestFlight build number and
exported app evidence revision. Do not record its serial number, UDID, personal
device name or account details. Verify the visible **Hardware validation** and
**Fixture Gateway** labels and the fixed storage/transport configuration before
any request. If these do not match, stop that app run and investigate the build.

1. **System Keychain:** initialize the synthetic credential once, then probe it
   read-only. Export a checkpoint. End the interaction, terminate/relaunch the
   app and probe before any reseeding; repeat after reboot and supported unlock.
   Compare recorded digest-equality observations. Probe canonical/foreign
   origin/account partitions, replace explicitly and test deletion last.
2. **Real local inference:** enable the local-only guard and use **Summarize
   known note using real LocalAI**. Require a real provider success and semantic
   coverage of the displayed synthetic note. Retain the actual model availability
   and finite error category. With ready model assets, the owner disables normal
   networking and repeats. A successful local response with unchanged Gateway
   attempt counters proves no application fallback during that observation.
3. **Shipping App Intent:** create **Arcanos Fixture Voice** in Shortcuts using
   this fixture app's **Ask Arcanos**, leaving Command unset for parameter
   prompting. Run it manually once, recording that as manual invocation. Also
   create a shortcut using **Check Latest Arcanos Job**.
4. **Vocal Shortcut:** the owner opens Settings > Accessibility > Vocal Shortcuts,
   selects the shortcut or a Siri Request to run it, and trains **Hey Arcanos**.
   Say the phrase, supply the request when prompted and authenticate normally.
   Record activation, capture, actual intent, selected route, audible result and
   visual presentation separately. [Apple Vocal Shortcut setup](https://support.apple.com/guide/iphone/use-vocal-shortcuts-iph7f242ea2c/ios).
5. **Accepted fixture recovery:** enable fixture Gateway, invoke the fixed **Run
   the hardware fixture operation** through the actual intent, and export the
   durable accepted operation/job checkpoint. End the interaction and perform
   one named lifecycle event. Invoke status again, observe the same identities,
   explicitly complete pending synthetic jobs and retrieve the authoritative
   result. Require one accepted submission and one semantic execution for that
   job, unchanged on repeated restoration. Actual HTTP attempts remain zero
   for this injected fixture; intercepted transport submissions are counted
   separately.
6. **Safety variants:** execute the device runbook's separate lost-receipt,
   synthetic authentication and exact-request confirmation scenarios. A stale
   approval, restart or recovery must never issue an approved mutation. Keep
   `tests.run` and `patch.apply` protected; no live executor or shell is involved.

Use **Refresh validation evidence** and **Export validation evidence** before
and after each observation. Save the finite diagnostic JSON, expected/observed
outcome and manual action in the run record. A report with `UNRECORDED` revision
cannot prove the tested commit. Never export the whole app container or Keychain.

The app remains iOS 18 compatible; real Foundation Models requires iOS 26+,
eligible hardware and a ready model. Let the owner manage Apple Intelligence
language, region and asset setup; report its true availability if unsupported.
[Apple Intelligence requirements](https://support.apple.com/en-us/121115).
Offline activation, dictation, inference and speech output are separate checks.
The app does not replace Siri's wake word or implement a background microphone.
A memory-only note captured in another process may be unavailable to a later
intent; record that fact rather than invent shared note persistence.

TestFlight does not provide an Xcode debugger. A user app-switcher dismissal is
the lifecycle action actually performed; it does not prove all intent-related
processes died. Compare the app's recorded process events and new process IDs,
but do not infer an unobserved system-host boundary. Reboot/unlock is independently
observable. Locked Keychain unavailability may be **BLOCKED** if the authenticated
intent waits for unlock or the OS suspends it. Do not weaken Keychain
accessibility/authentication or insert a background mode to manufacture that
test. The [full device procedure](PHASE3C_DEVICE_RUNBOOK.md) retains those limits.

## Independent evidence matrix and handoff

Use one record per action with revision, configuration, platform/model, OS/SDK,
real versus fixture components, command or manual interaction, expected/observed
outcome, evidence file and status. Allowed statuses are **PASS**, **FAIL**,
**BLOCKED** with its specific dependency, and **NOT RUN**. Tooling preparation is
not an Apple execution result.

| Level | Evidence required |
| --- | --- |
| A | Cloud Xcode/iOS compilation, package tests, metadata and source checks |
| B | Actual cloud Simulator-target build; unsigned build evidence only |
| C | Installed Simulator app execution and named fixture lifecycle proof |
| D | Real signed archive/export validation for the exact fixture identity |
| E | Explicitly authorized Apple upload receipt; record processing/tester availability separately |
| F | Physical system Keychain actions and lifecycle protection observations |
| G | Real Foundation Models execution, availability and local-only repeat |
| H | Physical shipping App Intent invocation and supported result interaction |
| I | Actual spoken Vocal Shortcut activation/capture/response |
| J | Physical fixture accepted-receipt recovery and verified per-job counts |
| K | Live ARCANOS services: NOT RUN under this scope |

Keep cloud artifacts bounded and sanitized with the workflow's short retention.
Keep reviewed physical evidence in repository-appropriate audit locations;
raw private device diagnostics stay outside commits. Cleanup is restricted to
the approved synthetic credential action and authorized run-owned artifacts.
Preserve unrelated state. Any rejected cleanup is recorded and left alone.

The first operator action after local preparation is to authorize publication of
the reviewed workflow revision. Once available on GitHub, obtain A/B/C evidence
without signing secrets. Configure protected Apple signing only after that
evidence passes. TestFlight publication requires its own explicit authorization.
Live validation remains a later shipping-build milestone described in the
[device runbook's live section](PHASE3C_DEVICE_RUNBOOK.md#g-separately-authorized-live-milestone-do-not-execute-now);
the fixture build cannot be converted to live operation by changing a setting.
