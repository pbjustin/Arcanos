# Copy-ready Gate R authorization request

Status: **READY FOR OPERATOR SUBMISSION — NOT YET AUTHORIZED OR EXECUTED**

The text below is intentionally self-contained. Submitting it as a new operator
instruction authorizes only the bounded Railway mutations it names.

---

# ARCANOS Phase 2E — Gate R: Private Credential-Containment Replacement

You are the lead Railway infrastructure-safety and credential-containment agent
responsible for Phase 2E Gate R.

Use parallel read-only sub-agents where useful and Railway CLI `4.30.2`. Work
from an isolated temporary CLI-link directory, not the repository.

## Authorization

The operator's submission of this prompt constitutes approval for **Gate R
only**.

Follow exactly:

```text
docs/audits/action-plan-execution/2026-07-18/private-only-gate-r/private-data-service-replacement-runbook.md
```

Target only:

```text
Railway project: Arcanos
Project ID: 7faf44e5-519c-4e73-8d7a-da9f389e6187
Environment: phase2e-validation-20260717
Environment ID: fb99f47d-5ef5-44c1-96c2-acf7b90fab13
```

You are authorized to:

1. Perform the runbook's sanitized read-only preflight and final isolation
   checks.
2. Stop, but never restart, these two compromised deployments:
   - PostgreSQL service `b7789306-8aef-4113-add5-02883a6cc087`
   - Redis service `434fa5b4-b52c-4caf-aaba-e87c173bf10d`
3. Create exactly one empty PostgreSQL replacement service named
   `phase2e-postgres-r2-20260718` and exactly one empty Redis replacement
   service named `phase2e-redis-r2-20260718`.
4. Attach exactly one new volume to each replacement:
   - PostgreSQL at `/var/lib/postgresql/data`
   - Redis at `/data`
5. Generate one independent 32-byte CSPRNG credential for each replacement,
   pass it to Railway through stdin, and keep its value out of Railway CLI
   command arguments, output, logs, files, reports, fingerprints, and chat.
6. Configure only the private variable/reference contracts and Redis start
   command specified by the runbook, always suppressing deployments while
   variables are set. Set both data services to bounded restart policy
   `ON_FAILURE` with maximum retries `3` before assigning a source.
7. Assign these image sources only after the empty-service, volume, variable,
   restart-policy, and zero-public-exposure pre-activation gate passes:
   - `ghcr.io/railwayapp-templates/postgres-ssl:18.4`
   - `redis:8.2.1`
8. Activate and fully verify PostgreSQL first. Only after PostgreSQL is healthy
   and still private-only may Redis be activated. Allow exactly one deployment
   for each new data service and run only the bounded in-container `pg_isready`
   and authenticated `redis-cli PING` health checks from the runbook. Limit
   each deployment wait to 120 read-only polls at five-second intervals and
   each health command to 15 seconds.
9. Change only `DATABASE_URL`, with `--skip-deploys`, on these two inactive
   validators so it references the replacement PostgreSQL service:
   - `d8d5181a-2f72-48d7-8413-6f05d113876c`
   - `febdf999-1c96-48df-8e28-c905b8b27082`
10. After both replacements are healthy and private-only and both validators
    remain undeployed with correct private references, retire only the two old
    compromised target-environment services by setting their exact
    service-level `isDeleted` fields to `true` through target-scoped `railway
    environment edit -e <environment-id> --service-config <service-id>
    isDeleted true` commands. Do not use `railway delete`, a dashboard deletion,
    or an unscoped service mutation.
11. After old service deletion, conditionally delete old volume
    `35c26093-1e3f-4d34-b699-89c65d2fb92d` and/or
    `d3690500-fcc5-4c06-afa6-cf30e91f608d` only if the exact volume still
    exists and is detached. If Railway removed a volume with its service, do
    not issue another deletion.
    This intentionally discards the old isolated preview database, including
    its migration ledger/schema state. Submission of this request accepts that
    preview-data loss; committed sanitized evidence remains, and Gate M must
    later rerun migration validation from a fresh database under separate
    approval.
12. Read deployment, service, volume, networking, and names-only variable
    metadata needed to prove containment and production non-impact.
13. Remove only the verified local temporary Railway-link directory when the
    operation ends.

Service deletion and conditional volume deletion are destructive operations.
They are authorized only by submission of this Gate R request and only after
the replacement and reference-cutover prerequisites above pass. The existing
runbook and its presence in Git are not authorization.

## Required ordering

Use this order without reordering:

```text
fixed-target preflight
→ stop both compromised deployments
→ create empty replacements (no database template and no image)
→ attach fresh volumes
→ generate/install credentials through stdin
→ configure private references and bounded restart policies with deployments suppressed
→ prove zero public exposure
→ activate and fully verify pinned PostgreSQL
→ activate and fully verify pinned Redis
→ cut over inactive validator references without deployment
→ prove validators remain inactive
→ delete old service identities
→ conditionally delete any surviving detached old volumes
→ final containment and production non-impact proof
```

Do not use `railway add --database`, `railway add --image`, `railway domain`, or
any TCP-proxy operation.

## Mandatory stop conditions

Stop and report without broad recovery if:

- the project, environment, old service IDs, old volume IDs, or validator IDs
  differ from the request;
- CLI behavior differs from the reviewed `4.30.2` help;
- either replacement name already exists;
- any target-environment application, worker, Python daemon, executor, or
  validator is active;
- private networking is disabled;
- an empty replacement has a source or deployment;
- a domain, TCP proxy, or `*_PUBLIC_URL` appears at any stage;
- a secret would be printed, stored, hashed, fingerprinted, reused, or passed
  as a command argument;
- a replacement has the wrong image, volume, mount, start command, or variable
  name set, or its restart policy is not `ON_FAILURE`/`3`;
- a replacement is unhealthy or cannot prove private-only networking;
- a validator deployment starts;
- an old reference remains after cutover;
- an old volume is attached when conditional deletion is reached;
- production or the Phase 2D environment would be selected or mutated; or
- Railway requests an operation outside this Gate R scope.

Once an old compromised deployment is stopped, never restart or redeploy it.
If a replacement fails, leave the old generation stopped. This gate authorizes
at most one creation attempt per data-service kind and no automated retry loop.

## Explicitly prohibited

This approval does not authorize:

- deployment or startup of `ARCANOS V2`;
- deployment or startup of `ARCANOS Worker`;
- deployment of either validator;
- startup of the Python daemon or any executor;
- application, validator, or manual database connection to the new services,
  except the two service-local health commands named above;
- Gate V, Gate M, Gate D, or any application deployment activity;
- any migration, DDL, schema verification, compensation, or database query;
- any ActionPlan, execution run, claim, start, result, retry, or acknowledgement;
- a public domain, custom domain, TCP proxy, public URL variable, or public
  connection;
- use of `DATABASE_PUBLIC_URL`, `REDIS_PUBLIC_URL`, or any production/Phase 2D
  credential;
- reading, printing, copying, comparing, hashing, fingerprinting, or storing
  credential values;
- provider, OpenAI, bridge, MCP mutation, healing, or automatic execution;
- a second replacement attempt;
- deleting the Railway environment;
- deleting either new replacement service or new replacement volume;
- mutating production or the Phase 2D environment;
- Git changes, commits, push, pull request, merge, or release; or
- any action not explicitly authorized above.

If a failed empty replacement must be removed, stop and request a narrowly
scoped cleanup approval naming its newly created service and volume IDs. Do not
silently consume a second replacement generation.

## Required evidence

Return one of:

```text
GATE R PASS
GATE R PASS WITH LIMITATIONS
GATE R FAIL
```

The final report must include only sanitized facts:

- CLI version;
- fixed project/environment identities;
- old stopped/deleted service and volume identities;
- new service, deployment, image/digest, and volume identities;
- private-network enabled status;
- domain and TCP-proxy counts before activation and after deployment;
- variable names and required-name-set match only;
- replacement health categories;
- validator IDs, deployment count, and private-reference match only;
- proof that old reference count is zero;
- proof that old service/volume IDs are absent;
- production and Phase 2D unchanged status based on non-secret identities;
- every command category executed, without secret-bearing output;
- stop conditions encountered;
- results of the exact target-scoped `isDeleted` service retirements and any
  conditional CLI volume deletion; and
- confirmation that no migration, application, worker, executor, provider,
  public networking, or Git operation occurred.

Never include raw Railway environment configuration, raw variable output,
private hostnames, connection strings, credentials, hashes of credentials, 2FA
codes, request payloads, database content, or unsanitized logs.

Gate R success contains the impact of the compromised preview credentials
only. It does not authorize or advance Gate V, Gate M, Gate D, preview
application deployment, or production release.

---
