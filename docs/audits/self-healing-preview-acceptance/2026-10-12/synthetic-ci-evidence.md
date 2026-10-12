# PR1539 synthetic source CI receipts

Final metadata snapshot: 2026-10-12T21:48:25Z. Existing authenticated GitHub reads only. No workflow dispatch/rerun/cancellation, reviews/comments/thread resolution, code changes, merge or Railway calls were performed by this monitor. Only this report was written.

## Commit binding and verdict

- Executable/source commit: `400be1912b9e429c9ea0ffdd8f0d07950a82d80c`.
- Current tested documentation repair head: `a7355c8cbe28ac5fdd285c45b031a4c07e416d22`.
- Base/current protected main: `3fd305b37ba410cf21684a8fed7619a1ba180b48`.
- GitHub compare confirms a735 is one commit ahead of400 and changes only `docs/audits/self-healing-preview-acceptance/2026-10-12/self-healing-preview-provisioning-plan.md` (2additions/2deletions). Executable, source, tests, configuration and dependencies are unchanged between these two heads.
- Both source400 full application workflows passed. **Source400 Documentation Audit failed**; its missing forward-link target was corrected by the documentation-only a735 commit. The historical failure is preserved, not waived or retroactively relabeled.
- At current a735, CI/CD, PR CI, Documentation Audit and API Endpoint Tests all completed SUCCESS. The actually required `docs:check` and `All Checks Complete` contexts both PASS.
- PR1539 remains OPEN/non-draft, MERGEABLE/CLEAN, labels empty, autoMerge null. One historical resolved/outdated review thread; zero unresolved threads, pagination complete. CodeRabbit remains paused and has no fresh current-head formal review. This metadata does not authorize merge, deployment or live runtime acceptance.
- A future final documentation/evidence commit needs its own exact-head workflow/check/thread refresh. The source400/a735 results remain immutable evidence of the recorded executable tree; they are not a PASS receipt for a future head.

## Workflow and aggregate receipts

| Head | Workflow | Actual result | Run |
| --- | --- | --- | --- |
|400|CI/CD|SUCCESS at21:42:51Z|[38310197168](https://github.com/pbjustin/Arcanos/actions/runs/38310197168)|
|400|PR CI|SUCCESS at21:36:52Z|[38310197304](https://github.com/pbjustin/Arcanos/actions/runs/38310197304)|
|400|Documentation Audit|FAILURE; missing forward-link target|[38310197295](https://github.com/pbjustin/Arcanos/actions/runs/38310197295)|
|400|API Endpoint Tests|SUCCESS|[38310197515](https://github.com/pbjustin/Arcanos/actions/runs/38310197515)|
|a735|CI/CD|SUCCESS at21:47:45Z|[38310400872](https://github.com/pbjustin/Arcanos/actions/runs/38310400872)|
|a735|PR CI|SUCCESS|[38310400914](https://github.com/pbjustin/Arcanos/actions/runs/38310400914)|
|a735|Documentation Audit|SUCCESS|[38310400863](https://github.com/pbjustin/Arcanos/actions/runs/38310400863)|
|a735|API Endpoint Tests|SUCCESS|[38310400946](https://github.com/pbjustin/Arcanos/actions/runs/38310400946)|

Source400 aggregate job [115020668402](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/job/115020668402) and a735 aggregate job [115022314375](https://github.com/pbjustin/Arcanos/actions/runs/38310400872/job/115022314375) both completed SUCCESS. The strict verifier requires all eleven direct dependencies equal success; skipped/failed/cancelled/missing/unexpected results fail it. Lint/type-check/commit guard, security audits, compiled build checks, integration/unit tests, Docker/static Railway compatibility, bounded deployment-readiness harness, Linux sandbox, Windows Python, convergence, disposable PostgreSQL and Redis jobs passed. No live Railway preview execution is credited: exact-head preview and sealed E2E jobs were intentionally skipped with no preview label.

## Full Jest: actual completed-job counts

All four full sweeps separately report **901passed suites +13skipped =914total** and **17,584passed tests +167skipped =17,751total**, with zero failures. They overlap and must not be added to a unique-test total.

| Head / job | Duration | Coverage statements / lines | Branches | Functions | Job |
| --- | --- | --- | --- | --- | --- |
|400 CI/CD unit|982.144s|93.57% (42,348/45,258)|87.32% (7,199/8,244)|95.79% (957/999)|[115014348255](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/job/115014348255)|
|400 PR CI|770.976s|93.57% (42,348/45,258)|87.33% (7,200/8,244)|95.79% (957/999)|[115013751510](https://github.com/pbjustin/Arcanos/actions/runs/38310197304/job/115013751510)|
|a735 CI/CD unit|1140.692s|93.57% (42,348/45,258)|87.33% (7,200/8,244)|95.79% (957/999)|[115015075833](https://github.com/pbjustin/Arcanos/actions/runs/38310400872/job/115015075833)|
|a735 PR CI|930.791s|93.57% (42,348/45,258)|87.33% (7,200/8,244)|95.79% (957/999)|[115014432930](https://github.com/pbjustin/Arcanos/actions/runs/38310400914/job/115014432930)|

The one-covered-branch difference is reported as observed, not averaged or retroactively changed. Coverage comes from completed Jest text summaries; there is no dedicated GitHub coverage/totals artifact in the workflow (LCOV is uploaded to Codecov).

The two unchanged suites that timed out in the root's resource-limited four-worker local attempt both explicitly passed in completed CI/CD logs:

-400: `native-pr-preview-application.test.ts`94.292s; `gaming-hybrid-lifecycle.integration.test.ts`11.46s.
-a735: same suites101.17s and14.23s.

No CI Gaming/native-preview timeout or functional regression was found. The root-reported interrupted local attempt (exit130) is not a full PASS and is outside these CI totals. Local lower-concurrency validation is tracked separately by root; no Gaming timeout/assertion relaxation was made by this monitor.

## Filtered integration and contract scopes

| Head / job | Actual Jest result | Duration |
| --- | --- | --- |
|400 [115014348211](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/job/115014348211)|37passed/12skipped suites (49total),744passed/162skipped tests (906total),0failures|83.975s|
|a735 [115015075810](https://github.com/pbjustin/Arcanos/actions/runs/38310400872/job/115015075810)|Same actual counts,0failures|79.146s|

Each observed offline contract command passed16 `live-pr-preview:offline` cases and234 `live-validation:offline` cases with no failures/skips/cancelled/todo. Each completed PR CI native containment command passed42cases, zero failures/skips. These repeat across jobs/heads and are not unique additions to full Jest. Source400 compiled model-policy4cases and heartbeat6cases passed in [build job115014348817](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/job/115014348817), with no failures/skips/cancelled/todo; synthetic compiled-runtime checks are not live provider acceptance.

## Guarded disposable PostgreSQL18

| Head / PostgreSQL job | Local-agent command | Fencing/atomicity/storage/retention command | Swift device proof |
| --- | --- | --- | --- |
|400 [115013751205](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/job/115013751205)|1suite/6tests PASS,1.162s|15suites/202tests PASS,177.057s|19/19assertions PASS|
|a735 [115014432838](https://github.com/pbjustin/Arcanos/actions/runs/38310400872/job/115014432838)|1suite/6tests PASS,0.805s|15suites/202tests PASS,114.211s|19/19assertions PASS|

No PostgreSQL suite/test skips or failures appeared. The job provisions `postgres:18-alpine` and sets required-database mode with explicit guarded credentialed loopback URLs, not ambient database fallback. The actual script/logs show15fencing suites; the generic old workflow echo saying “nine” is not used as the count.

Both Swift reports say executed=true, all19assertions passed, six shipping-recovery processes completed, one synthetic AI execution and one synthetic executor execution, schema removed and server closed. The API transport is a loopback test adapter and provider/executor outputs are synthetic; real disposable SQL/HTTP/locking evidence does not establish Railway/live-model acceptance. Reported checkout SHAs are7477af901bf45b8d86677abca979b2e8733e3913 (source400 run) and8062c93e9f6524b7edd14d604ff33602e5aad929 (a735 run), the observed PR merge checkouts. They are recorded separately from run.headSha/PR head, not mislabeled as the source-head SHA.

## Standalone runtime and disposable Redis

| Command | Actual400 result | Actuala735 result |
| --- | --- | --- |
|`test:runtime-integration`|79tests/7suites PASS;650.455ms|79tests/7suites PASS;596.643ms|
|`test:runtime-redis-integration`|4tests/1suite PASS;283.086ms|4tests/1suite PASS;301.346ms|
|`test:public-provider-redis-integration`|Jest1suite/14tests PASS;2.325s|Jest1suite/14tests PASS;2.301s|

Source [Redis job115014348133](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/job/115014348133) and a735 [Redis job115015075783](https://github.com/pbjustin/Arcanos/actions/runs/38310400872/job/115015075783) both passed, no failures/skips/cancelled/todo. The job provisions `redis:7.4-alpine`, uses loopback DB15 for runtime/BullMQ and DB14 for public admission, and passes explicit disposable-confirmation markers. Standalone node:test suites are excluded from root Jest; scopes are reported separately without adding repeated job runs.

## Retained GitHub artifacts

All artifact IDs below were independently read back and unexpired at the final snapshot. Receipt uploads and terminal workflow/aggregate success were verified separately; receipt collection itself occurs before aggregate completion.

| Head | Artifact name | ID / retention |
| --- | --- | --- |
|400|`ci-verification-receipts-400be1912b9e429c9ea0ffdd8f0d07950a82d80c-1`|[11774594753](https://github.com/pbjustin/Arcanos/actions/runs/38310197168/artifacts/11774594753),30days|
|a735|`ci-verification-receipts-a7355c8cbe28ac5fdd285c45b031a4c07e416d22-1`|[11775735882](https://github.com/pbjustin/Arcanos/actions/runs/38310400872/artifacts/11775735882),30days|
|400|`ios-device-e2e-proof-7477af901bf45b8d86677abca979b2e8733e3913`|11774760575,7days|
|a735|`ios-device-e2e-proof-8062c93e9f6524b7edd14d604ff33602e5aad929`|11773819593,7days|
|400|`build-artifacts`|11774272838,1day|
|a735|`build-artifacts`|11774009713,1day|
|400|`converge-artifacts`|11774625567,30days|
|a735|`converge-artifacts`|11773724711,30days|
|400|`gitleaks-results.sarif`|11774227458|
|a735|`gitleaks-results.sarif`|11773889452|

## Historical documentation blocker and repair

Source400 [docs job115013751381](https://github.com/pbjustin/Arcanos/actions/runs/38310197295/job/115013751381) reported977/978checks passed, one failure: `self-healing-preview-provisioning-plan.md` linked `synthetic-verification-report.md`, which had not been published. The minimal doc-only repair linked the existing acceptance README. Fresh a735 [docs job115014432692](https://github.com/pbjustin/Arcanos/actions/runs/38310400863/job/115014432692) passed. Source400 still has that failed historical workflow; current a735 required documentation evidence is a distinct successful run.

## Verification mechanics and limits

Run/job discovery used `gh run list --commit <full-SHA>` and `gh run view <run-ID> --json headSha,status,conclusion,jobs,updatedAt`. Completed logs were fetched sequentially and only finite summaries were retained here. Direct decoded GitHub job-log reads supplied PG/Redis/integration/Swift/build counts; a later connector transport close was handled with existing authenticated `gh run view --job <job-ID> --log` after workflow completion. A single running-job log request returned BlobNotFound; it was not classified as a test failure or repeatedly polled. gh does not expose run logs until whole-workflow completion even when the individual job has completed.

```bash
gh run view 38310197168 --repo pbjustin/Arcanos --job 115014348255 --log
gh run view 38310197304 --repo pbjustin/Arcanos --job 115013751510 --log
gh run view 38310400872 --repo pbjustin/Arcanos --job 115015075833 --log
gh run view 38310400914 --repo pbjustin/Arcanos --job 115014432930 --log
gh api repos/pbjustin/Arcanos/actions/runs/38310197168/artifacts
gh api repos/pbjustin/Arcanos/actions/runs/38310400872/artifacts
gh pr checks 1539 --repo pbjustin/Arcanos --required
gh pr view 1539 --repo pbjustin/Arcanos --json headRefOid,state,isDraft,mergeable,mergeStateStatus,reviewDecision,labels,autoMergeRequest
gh api repos/pbjustin/Arcanos/branches/main --jq '{sha:.commit.sha,protected}'
```

Log commands were projected with bounded summary regexes for Test Suites/Tests/Time, coverage percentages/counts and node:test tests/pass/fail/skipped; raw credential/environment/payload output is not reproduced. The GraphQL final thread page reported hasNextPage=false, head=a735/base=3fd, sole thread resolved/outdated. No human/current-head bot approval, live Railway self-healing scenario, paid provider availability, production safety rollout or merge authorization is inferred from these successful synthetic/disposable CI receipts.
