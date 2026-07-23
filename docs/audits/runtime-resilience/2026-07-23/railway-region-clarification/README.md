# Railway Redis region clarification

Date: 2026-07-23

## Final classification

```text
REGION PREREQUISITE SATISFIED
NO MIGRATION REQUIRED
REDIS OUTAGE GATE READY FOR SEPARATE APPROVAL
```

This classification is limited to the region prerequisite. It does not authorize
an outage, restart, redeploy, region change, volume operation, or any production
action.

## Evidence-backed decision

- Railway currently documents `us-east4-eqdc4a` as **US East Metal,
  Virginia, USA**.
- The accepted Redis deployment's control-plane manifest uses exactly
  `us-east4-eqdc4a`.
- The dashboard shows Redis Preview and its attached volume in
  **US East (Virginia, USA)**. It offers only one US East choice, and that
  choice is already selected.
- Railway documents no separate region-normalization concept, state, or
  operation. The supported conclusion is that no region action is needed to
  reach the documented target; it is not a claim about an undisclosed internal
  mechanism.
- The repository's original outage proposal and both committed Redis
  resilience runbooks do not require region migration.
- The later migration prerequisite was an operator safety condition based on
  an inferred platform concern, not a documented Railway requirement.
- Changing the region of a volume-backed service would add downtime and a
  volume migration whose exact identity and rollback behavior are not
  documented. That mutation would add risk without improving the intended
  dependency-loss proof.

## Current healthy baseline

Three bounded samples completed on 2026-07-23:

| Probe | Result |
| --- | --- |
| `/health` | 3/3 HTTP 200 |
| `/healthz` | 3/3 HTTP 200 |
| `/readyz` | 3/3 HTTP 200 |
| Listener | bound |
| Redis lifecycle | ready |
| Circuit | closed |
| Retry | idle |
| Sensitive output | none observed |

## Evidence classification matrix

| Question | Official docs | Dashboard/control plane | Support needed | Conclusion |
| --- | --- | --- | --- | --- |
| Current region is US East | `us-east4-eqdc4a` maps to US East/Virginia | Exact key and label observed | No | Confirmed |
| Current ID is normal/current | Listed in current Regions and Config-as-Code docs | Accepted deployment uses it | No | Confirmed |
| Normalization required | No such requirement or workflow documented | No warning, pending state, or action shown | No for this test | No region action is needed to reach the documented target |
| Service identity preserved by region migration | Not guaranteed | Not exercised | Yes, before any migration | Unverified and irrelevant here |
| Volume identity preserved by region migration | Not guaranteed | Not exercised | Yes, before any migration | Unverified and irrelevant here |
| `/data` preserved by region migration | Not guaranteed | Current attachment is `/data` | Yes, before any migration | Current attachment confirmed; migration behavior unverified |
| Private networking preserved by region change | Railway says region changes do not change private networking | Current private DNS is ready | No for no-change path | Confirmed for current placement |
| Downtime | Volume-backed region changes cause downtime | Not exercised | No | Documented |
| Migration rollback | No region-volume rollback contract found | Not exercised | Yes, before any migration | Unverified |
| Supported outage operation | Remove stops a deployment without removing the attached volume; a Removed deployment can be manually redeployed | Current deployment reports `canRedeploy=true` | Only if the exact retained-image restore action is ambiguous | Revised gate requires the visible exact restore action before stop |

## Files

- `current-placement.json`
- `region-semantics.json`
- `volume-preservation-analysis.json`
- `service-identity-analysis.json`
- `private-network-analysis.json`
- `prerequisite-origin.json`
- `outage-prerequisite-review.md`
- `risk-comparison.json`
- `railway-support-request.md`
- `revised-outage-gate.md`
- `independent-review.md`

## Non-action statement

```text
Redis migration performed: NO
Redis outage performed: NO
Redis restart or redeploy performed: NO
Production changed: NO
Support request submitted: NO
```
