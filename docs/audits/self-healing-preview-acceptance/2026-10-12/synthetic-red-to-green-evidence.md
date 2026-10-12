# Synthetic red-to-green regression evidence

Assessment started at `1aca3cbf82c95a89cd9c7b5bad8c6478e1fa2988`. Failing fixtures executed before their respective corrections in the shared working tree; these are not individually committed pre-fix builds. Final corrected executable and fixture commit: `400be1912b9e429c9ea0ffdd8f0d07950a82d80c`.

All logs below contain deterministic synthetic data. The original files remain under `/tmp` in the execution workspace; hashes and sanitized assertion summaries preserve the relevant findings in the PR. Fixture bring-up/import failures are excluded from application defects. Selection-only skips in red runs are not final skipped coverage.

| Captured failing behavior | Expected | Observed before correction | Regression fixture |
| --- | --- | --- | --- |
| Same-action old completion or old timeout credits replacement | New command success count 0 | Count 1 | `tests/self-healing-v2.test.ts`, real older-consumer and intake-timeout cases in `tests/self-healing-trinity.integration.test.ts` |
| Indefinite prompt mitigation, both policies | Inactive at ten-minute TTL, normal policy restored | Still active | `tests/prompt-route-mitigation.test.ts`, actual prompt restoration in `tests/openai-prompt.test.ts` |
| Same-clock older prompt rollback | Replacement remains active | Replacement cleared | Prompt replacement unit and canonical-controller integration cases |
| Failed mitigation consumer accounting | Two real failures clear command and impose cooldown | Failure count remained 0 | Direct and final-bypass two-failure cases in `tests/self-healing-trinity.integration.test.ts` |
| Simultaneous intake and final action attribution | Final success count 1, intake 0 | Final remained 0 despite actual final bypass | Architectural-mode composite case in Trinity integration |
| Repeated V2 failure storage | At most threshold 3 observations | 1,000 retained | `tests/self-healing-v2.test.ts` bounded observations |
| Health-only, unknown, same-clock or insufficient recovery traffic | No improved verification | Improved accepted | Freshness/unknown-attribution cases in controller integration |
| Failed provider reload | No pending verified recovery | Empty later traffic appeared improved | Provider `ok:false` cases in controller integration |
| Ineffective cooldown key | Next dispatch suppressed | A second reload dispatched | Controller ineffective-provider cooldown case |
| Vanished/unrelated HTTP traffic after queue repair | Unchanged queue is not recovered | Improved accepted | Unchanged-worker integration cases |
| Missing worker inspection/queue summary | No usable queue improvement | Missing data looked like zero stalls and allowed improved | Controller missing-worker-data cases |
| DAG control route mistaken for consumer | No recovered Trinity consumer | Improved accepted from three control requests | Controller DAG control-route case |
| Same-route diagnostic completions | No recovery without consumer receipts | Improved accepted with zero command/provider successes | Controller nonconsumer receipt cases and real SDK positive joins |
| Strict-freshness implementation follow-up starvation | Ownership expires within existing incident window | Later queue repair blocked indefinitely | Controller evidence-starvation regression; this was caught during repair, not claimed as an additional original-head defect |

Final joined-source focused rerun: **47 suites / 1,379 tests passed, zero skipped**. All final full regression and CI totals are in [synthetic verification](synthetic-verification-report.md).

## Original red-log receipts

| Basename | SHA256 |
| --- | --- |
| `pr1539-synthetic-controller-consumer-receipts-red.log` | `08742362f637bc3274a03cb9c35c50817037cc0582541d7198704e696d89160d` |
| `pr1539-synthetic-controller-missing-worker-observation-red.log` | `4c0d4998f5cf81bff4ffcf0f7c5bb899c71d6f63e7101a891a5ca805276a50e2` |
| `pr1539-synthetic-controller-provider-red.log` | `0ec6c7283cdbec6cb15123b162162f1fdcd64a04793ef0b833f8083a9c240a89` |
| `pr1539-synthetic-controller-provider-worker-red.log` | `326d0a03ac993b3ade77d4be3db38535d778a113b8453a5ccef83918491563fb` |
| `pr1539-synthetic-controller-red.log` | `09d08cca6558b07a076e592c2766857aa7112cd3987b2156d4a21791e8b1e03b` |
| `pr1539-synthetic-controller-starved-verification-red.log` | `f9d6c36e9a7d904b23411ab376df280e7b62a7bc7690747e40bfd7ce85270d41` |
| `pr1539-synthetic-controller-unknown-route-red.log` | `0b82344e904db869087fb891800f38209df1c9fb39478924cc59f2db57385e49` |
| `pr1539-synthetic-controller-worker-control-route-red.log` | `f431e6225a80d7a5dfa19ebc9b0b25be138b35d4003cc3dd51fa28b2aa10c040` |
| `pr1539-synthetic-controller-worker-traffic-red.log` | `1a34d64cf13037f6d02dca32ffda72ff4a887ba5ee8a6df5021aa6fb67b9146b` |
| `pr1539-trinity-composite-red.log` | `1cb77252ca31ed3f8eae24290e116747d02fe2a39514e0cf8ccf2b878d447fda` |
| `pr1539-trinity-consumer-failures-red.log` | `4e4c0733f7676a65dc59136fb18be4e2000eb7cfbd4edb57e5e21c75feec91c1` |
| `pr1539-trinity-consumer-red.log` | `c7becf1570fcff180ad672ef66a8267d206509e6ea57a5a558da06204262fe94` |
| `pr1539-trinity-observations-red.log` | `65ccdda397c332ffcc46487b8c551ae3bda32b7cf91adaabdbc43a01d9e8b69e` |
| `pr1539-trinity-red.log` | `927ec5a02ea0c21aa981cf0e1997ae06708a7ed27e865ecac60c0111c56f3d92` |
| `pr1539-trinity-timeout-replacement-red.log` | `1666d17d0eb9d7b21575bbb20dd58e3e08f0b866a2418ffec7a54047c3e64193` |

Individual logs can contain multiple regression assertions or intentionally unselected tests; their counts must not be added to final passing totals. No log proves live provider availability, Railway deployment, or production recovery.
