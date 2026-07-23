# Copy-ready Railway Support request

Status: **PREPARED, NOT SUBMITTED**

This request is not required while every revised pre-stop preservation and
retained-image restoration check is unambiguous. It becomes required if the
exact restore action, service/volume attachment, private networking, or
identity behavior is ambiguous, and before any future region migration where
exact service, volume, mount, or rollback guarantees are necessary.

```text
Subject:
Clarification on current Redis region placement and retained-volume behavior
during a bounded isolated outage test

Project:
Arcanos

Project ID:
7faf44e5-519c-4e73-8d7a-da9f389e6187

Environment:
dep-resilience-preview-28f408c

Environment ID:
ef75c32a-0e1c-4b82-b0f9-6a5b2951595b

Redis service ID:
d9849f88-89c0-4650-86de-7ee07acc7f08

Current accepted deployment:
bb9e73c1-6da5-4ae0-b1b4-b6380724bbd3

Attached volume ID:
60326a10-1f7f-40a5-bd79-2dbc0ffa4479

Mount:
/data

Current dashboard region:
US East (Virginia, USA)

Current region identifier observed:
us-east4-eqdc4a

We are preparing one bounded resilience experiment in an isolated preview. The
intended operation is to make only this Redis deployment unavailable for no
more than five minutes, then restore the same Redis service with its retained
volume. No production resource is involved.

Please confirm:

1. Is us-east4-eqdc4a already the current supported US East/Virginia
   placement?
2. Is any region normalization or migration required?
3. If the dashboard shows only the same US East destination, would selecting
   it perform a no-op, redeploy, or volume migration?
4. Is deployment Remove followed by Redeploy a supported bounded stop/restore
   procedure for this service?
5. Does that procedure preserve:
   - service ID d9849f88-89c0-4650-86de-7ee07acc7f08;
   - volume ID 60326a10-1f7f-40a5-bd79-2dbc0ffa4479;
   - any underlying volume-instance identity;
   - the /data attachment;
   - service variables and configuration;
   - private DNS and environment-local networking?
6. Which deployment and runtime-instance identities should change?
7. Does the configured restart policy interfere with intentionally keeping the
   deployment unavailable for up to five minutes?
8. Is a safer non-destructive stop/start operation available through the
   dashboard, CLI, API, or Railway Support?
9. What downtime should be expected?
10. What rollback is supported if the removed deployment cannot be restored?
11. Is any migration needed before we perform this stop/restore experiment on
    the existing isolated service and retained volume?

No credentials, connection strings, Redis data, variables, internal logs, or
customer data are included in this request.
```
