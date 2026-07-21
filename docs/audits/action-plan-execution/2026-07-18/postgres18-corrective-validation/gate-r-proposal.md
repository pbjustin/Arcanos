# Gate R draft — not ready to request

This is a containment design record, not an executable proposal. No Gate R
approval is requested.

## Target and current state

- Project: Arcanos (`7faf44e5-519c-4e73-8d7a-da9f389e6187`)
- Environment: `phase2e-validation-20260717`
  (`fb99f47d-5ef5-44c1-96c2-acf7b90fab13`)
- Compromised PostgreSQL service: `b7789306-8aef-4113-add5-02883a6cc087`
- Compromised Redis service: `434fa5b4-b52c-4caf-aaba-e87c173bf10d`
- No web, worker, Python executor, or active validator deployment exists.
- The public schema contains no Phase 2E application data requiring retention.
- Both current data services have zero public domains and zero TCP proxies.

## Recommended containment

Replace both data services, then retire the compromised services and volumes.
Railway CLI 4.30.2 exposes no credential-rotation operation whose immediate
invalidation can be proved without using the compromised values. Replacement
plus retirement creates a provable credential-generation boundary.

## Blocking infrastructure fact

Railway's default PostgreSQL and Redis templates create TCP proxies. Therefore
the default database-add operation is not acceptable for this environment,
even if a later step could remove the proxy. It would violate the requirement
that no public endpoint be created.

Before Gate R can be requested, the operator and infrastructure reviewer must
identify and validate an exact, private-only provisioning procedure. A possible
direction is a target-scoped empty service using an approved official database
image, private networking, a dedicated volume, and an explicitly reviewed
variable contract. This document does not authorize or assert that design.

## Required future operation sequence

1. Prove the exact replacement procedure creates no domain or TCP proxy at any
   point, and document its image, volume, health check, variable contract, and
   rollback operations.
2. Obtain separate approval to retire the two inactive validator services that
   retain stale references. Do not mutate their variables in a way that could
   start a deployment.
3. Create one private-only PostgreSQL replacement and one private-only Redis
   replacement in the target environment. Never print or store their values.
4. Verify distinct service, deployment, and volume identities; healthy status;
   private-only networking; and zero domains and TCP proxies.
5. Do not connect or deploy an application or validator.
6. After the replacements pass isolation checks, obtain teardown authority and
   retire only the compromised services and their attached volumes.
7. Prove invalidation through absence of the old service and volume identities,
   private endpoints, and references. Never authenticate with the exposed
   values.
8. Repeat the complete Gate C isolation proof and verify production and Phase
   2D remain unchanged.

## Variables affected by name only

`DATABASE_URL`, `DATABASE_PUBLIC_URL`, `REDIS_URL`, and `REDIS_PUBLIC_URL`.
No value may be displayed, copied, compared, hashed, or stored. Future
validators and applications must have no public-URL variable available.

## Rollback

Before retiring the old services, discard a failed replacement under separately
approved teardown authority and create another fresh generation. After
retirement, never restore the compromised generation; create another fresh,
private-only generation. No application or migration rollback is involved.
