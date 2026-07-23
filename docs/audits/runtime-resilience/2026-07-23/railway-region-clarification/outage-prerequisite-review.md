# Redis outage prerequisite review

## Verdict

```text
prerequisite unnecessary
```

The intended experiment tests dependency loss and application recovery:

```text
existing preview Redis becomes unavailable
→ web liveness remains available
→ readiness degrades
→ Redis-dependent operations fail safely
→ the same Redis service returns with its retained volume
→ readiness recovers without web or worker restart
```

A region migration is not part of that causal chain. Redis is already configured
in Railway's current US East/Virginia region. Adding a stateful region and
volume migration would introduce a second failure domain and make the result
harder to interpret.

## Why the old gate stopped correctly

The previous authorization explicitly ordered migration before outage. Once the
dashboard could not prove a same-volume migration, stopping was the correct
response. This review does not retroactively change that historical decision.
It establishes that the ordered prerequisite itself was not based on a
documented Railway requirement.

## Current support

- Current official Railway documentation maps `us-east4-eqdc4a` to US East
  Metal in Virginia.
- Current control-plane deployment metadata uses exactly that key.
- The dashboard shows both Redis and its attached volume in US East.
- No current Railway documentation defines a separate normalization state or
  action.
- Original ARCANOS outage runbooks omit the prerequisite.

## Revised gate implications

Remove the region-migration prerequisite. Keep these stronger safeguards:

1. Reverify the exact project, environment, Redis service, deployment, volume,
   `/data` mount, and private DNS.
2. Require current web and worker deployment and process identities to be
   recorded and unchanged throughout.
3. Require the exact restoration action to be available before stopping Redis.
4. Prohibit service creation, replacement volumes, detachment, region changes,
   source uploads, configuration changes, and fallback deployment from a
   reconstructed definition.
5. Enforce the five-minute outage ceiling and immediate abort conditions.

The revised gate remains a proposal. No outage is authorized by this review.
