# Independent review

## Final verdict

```text
REGION PREREQUISITE SATISFIED
```

The current accepted Redis deployment uses Railway's currently documented
US East Metal/Virginia identifier, `us-east4-eqdc4a`. Railway says an attached
volume migrates only when its service region changes. No region change is
required or proposed.

The no-region-change outage path is supportable because current Railway
documentation states:

- Remove stops a deployment rather than deleting its service.
- Removing a deployment does not remove the attached volume.
- A Removed deployment can be manually redeployed from its deployment menu.
- Redeploy creates a new deployment using the selected deployment's code and
  configuration.
- Private DNS is scoped to the unchanged service and environment and derived
  from the service name.

## Mandatory pre-stop conditions

1. The exact Redis deployment must report `canRedeploy=true` and expose the
   visible retained-image restoration action.
2. Redis restart policy must remain `ON_FAILURE` with 10 retries; serverless
   must remain disabled.
3. Queue and Redis state must be disposable and quiet. Possible loss inside the
   RDB `save 60 1` window must be explicitly accepted.
4. Restoration must begin within 90 seconds and Redis must reach application
   `READY` within five minutes of confirmed stop.
5. Redis service ID, service-instance ID, logical volume ID, `/data`, service
   name, and private hostname must remain fixed. A new deployment and
   replica/runtime instance are expected.
6. No staged Redis change, `railway up`, reconstructed service, replacement
   resource, volume operation, or region change is allowed.

## Documentation-review dissent

The independent documentation reviewer preferred:

```text
RAILWAY CONFIRMATION REQUIRED
```

That reviewer considered the lack of an express guarantee for every internal
identifier across Remove/redeploy a blocker. The final reviewer treated this as
a limitation rather than a region blocker because Railway expressly documents
retention of the attached volume and manual redeploy of a Removed deployment,
while the proposed action does not target the service, volume, attachment,
region, or networking.

Railway confirmation becomes mandatory if:

- the hidden volume-instance identity must be guaranteed;
- zero Redis-key loss is required; or
- any exact preservation or retained-image restore check is ambiguous.

## Final gate

```text
Redis outage experiment:
READY FOR SEPARATE APPROVAL

Redis migration performed:
NO

Redis outage performed:
NO

Production changed:
NO
```
