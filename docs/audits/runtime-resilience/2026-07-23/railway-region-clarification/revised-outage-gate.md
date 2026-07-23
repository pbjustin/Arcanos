# Revised Redis outage/recovery authorization proposal

Status: **NOT AUTHORIZED**

This proposal removes the stale region-migration prerequisite. Submission or
review of this file does not authorize any Railway mutation.

## Proposed classification

```text
NO REGION MUTATION REQUIRED
OUTAGE EXPERIMENT READY FOR SEPARATE APPROVAL
```

## Exact scope

- Project: `Arcanos` (`7faf44e5-519c-4e73-8d7a-da9f389e6187`)
- Environment: `dep-resilience-preview-28f408c`
  (`ef75c32a-0e1c-4b82-b0f9-6a5b2951595b`)
- Redis service: `Redis Preview`
  (`d9849f88-89c0-4650-86de-7ee07acc7f08`)
- Redis service instance:
  `e08bcaee-e1f4-4004-bf9b-cb1727564887`
- Current Redis deployment:
  `bb9e73c1-6da5-4ae0-b1b4-b6380724bbd3`
- Retained logical volume:
  `60326a10-1f7f-40a5-bd79-2dbc0ffa4479`
- Required mount: `/data`
- Web deployment that must remain unchanged:
  `fa5af698-ca43-4e6c-ab9e-76dfd1c89c9f`
- Worker deployment that must remain unchanged:
  `23fc639c-e05d-48ec-bff7-7bb9878e963d`
- Restoration start deadline: 90 seconds after confirmed stop
- Hard stop-to-`READY` ceiling: five minutes

## Mandatory pre-stop gate

Before any separate outage authorization is exercised:

1. Verify the exact project and preview environment IDs.
2. Verify Redis service, service instance, current deployment, logical volume,
   `/data` attachment, image, persistence, and private DNS.
3. Verify region remains `us-east4-eqdc4a` /
   `US East (Virginia, USA)`. Do not change or reselect it.
4. Verify Redis remains unexposed: no service/custom domain and no TCP proxy.
5. Verify web and worker deployment and process-instance identities, then arm
   continuity monitoring.
6. Require three consecutive HTTP 200 samples from `/health`, `/healthz`, and
   `/readyz`; Redis must be ready, retry idle, and circuit closed.
7. Record ready generation and recovery count.
8. Reverify Redis has restart policy `ON_FAILURE` with 10 retries and
   serverless disabled. An unknown policy or `Always` blocks the experiment.
9. Verify queue state is empty, Redis state is disposable, provider calls are
   zero, and dangerous features remain disabled/inert. Hold a quiet, no-write
   dwell of at least 70 seconds before stop. This reduces RDB exposure but is
   not a zero-loss guarantee.
10. Explicitly accept that Redis uses RDB `save 60 1` with AOF disabled and
    that a platform stop may not allow a final snapshot. If zero key loss is
    required, do not perform this experiment.
11. Start the bounded outage/recovery sampler before the stop.
12. Verify the exact deployment reports `canRedeploy=true` **and** exposes a
    visible retained-image restore action that uses the same deployment
    history. Confirm the exact same-service restoration action is independently
    reviewed.
13. Verify there are zero staged or pending Redis service changes.
14. If restoration would require `railway up`, a new service, replacement
    volume, detach/attach, region change, source upload, reconstructed
    configuration, or application of staged changes, do not stop Redis and
    obtain Railway confirmation.

## Proposed stop

Stop only the current preview Redis deployment using Railway's deployment
Remove operation. Confirm the exact deployment ID immediately before the
action.

Do not delete the service or volume. Do not change region, variables, image,
start command, persistence, networking, or any other service.

## Outage acceptance

- `/health` and `/healthz` remain HTTP 200 with listener bound.
- `/readyz` becomes HTTP 503 with sanitized Redis-unavailable semantics.
- Circuit becomes open or half-open; retries remain serialized and bounded.
- One bounded Redis-dependent no-op fails within two seconds with
  `REDIS_DEPENDENCY_UNAVAILABLE`.
- Edge 502 count remains zero.
- Web and worker deployment and process identities remain unchanged.
- No duplicate consumer, lifecycle owner, client owner, or retry loop appears.
- No provider, callback, bridge, ActionPlan, healing, or external effect occurs.

## Mandatory restoration

Begin the reviewed restoration action promptly after the required degraded
samples and no later than 90 seconds after confirmed stop. Redis must return to
control-plane `SUCCESS` and application `READY` within a hard five-minute
stop-to-ready ceiling.

Use only Railway's reviewed redeploy action on the same Redis service and
retained deployment history.

There is no fallback to:

- create or replace the Redis service;
- create, replace, restore, detach, attach, copy, or migrate a volume;
- deploy from local source or a reconstructed service definition;
- change region, networking, variables, image, command, or persistence.

If the exact same-service restore action is unavailable, the pre-stop gate must
have failed and the outage must not begin.

## Recovery acceptance

- Same Redis service ID and logical volume ID remain attached at `/data`.
- Same environment-specific Redis service-instance ID remains.
- A new Redis deployment and replica/runtime instance are allowed and expected.
- Private DNS returns ready without web or worker variable changes.
- `/health` and `/healthz` remain 200 throughout.
- `/readyz` returns to 200 without web or worker restart/redeploy.
- Circuit closes, retry stops, recovery count and ready generation increase.
- Queue and worker remain healthy with no duplicate work or external effect.
- Two-minute stable dwell passes.
- Production deployment IDs remain unchanged.

## Immediate abort conditions

Restore immediately and fail the experiment for any liveness failure, 502,
timeout, web/worker restart, wrong target, service/volume mismatch, private
networking change, public exposure, provider call, duplicate initialization,
sensitive disclosure, retry storm, loss of the exact retained-image restore
action, or risk of exceeding the five-minute stop-to-ready ceiling.

## Required separate approval

A later approval must quote the exact current IDs and explicitly authorize one
bounded stop and restoration. This file does not provide that approval.

If any pre-stop preservation or retained-image restoration check is ambiguous,
the support request in `railway-support-request.md` becomes mandatory and the
outage remains blocked.
