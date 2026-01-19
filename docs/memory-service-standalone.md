# ARCANOS Memory Service Standalone Express Scaffold
> **Last Updated:** 2025-02-14 | **Version:** 1.0.0

## Overview
The ARCANOS memory service ships with a lightweight Express scaffold designed to run as a standalone process (`this.standalone` mode) when the broader platform is unavailable or during local development. The scaffold exposes a minimal REST surface for committing and retrieving trace memories while layering the same authentication, auditing, and resiliency guardrails used in production deployments.

This guide explains how the standalone server is composed, how requests flow through the stack, and which configuration switches control its behavior.

## Runtime Entry Points
| File | Responsibility |
| ---- | -------------- |
| `memory-service/src/server.js` | Boots the Express application on the configured port and logs readiness. |
| `memory-service/src/app.js` | Registers global middleware (Helmet, CORS, JSON body parsing, Morgan) and mounts the memory routes and `/health` probe. |
| `memory-service/src/routes/memoryRoutes.js` | Declares the `/commit` and `/retrieve/:traceId` endpoints and attaches the shared middleware chain. |
| `memory-service/src/controllers/memoryController.js` | Implements request handlers that call into the memory service layer and translate exceptions to HTTP responses. |
| `memory-service/src/services/memoryService.js` | Validates payloads with Zod, generates trace IDs, persists entries to the in-memory store, and performs lookups. |
| `memory-service/src/services/auditService.js` | Emits structured audit records when requests complete, honoring the configured log level. |
| `memory-service/src/middleware/*.js` | Provides authentication, timeout protection, and audit hooks for every request. |
| `memory-service/src/config/env.js` | Loads environment variables and exposes the configuration object consumed across the stack. |

## Request Lifecycle
1. **Inbound request** – Clients call `/api/memory/commit` or `/api/memory/retrieve/:traceId` after the Express instance starts listening on `config.port` (defaults to `8080`).
2. **Middleware envelope** – The route applies `auth`, `resilience`, and `audit` middleware before invoking the controller. Authentication enforces a bearer token, resilience applies a 15s timeout guard, and audit schedules request logging when the response finishes.
3. **Controller dispatch** – `commitMemory` and `retrieveMemory` forward work to the memory service and translate failures into `500` errors.
4. **Service logic** – `memoryService.commit` validates payload shape, assigns a UUID when the client omits `trace_id`, and saves the enriched record (including a `saved_at` timestamp) into an in-memory `Map`. `memoryService.retrieve` fetches the record or returns a `404` payload when it is missing.
5. **Audit emission** – Once the response ends, the audit middleware writes a structured log line containing HTTP method, route, status, and duration when the configured log level allows it.

## Configuration Surface
All configuration is sourced from environment variables loaded via `dotenv`:

- `PORT` – TCP port for the standalone listener (`8080` default).
- `NODE_ENV` – Environment label stamped onto audit entries (`development` default).
- `AUTH_TOKEN` – Bearer token required by the auth middleware; leave unset to bypass authentication during early development.
- `OPENAI_API_KEY` – Optional key for integrations that need the prepared OpenAI SDK client.
- `AUDIT_LOG_LEVEL` – Controls verbosity of the audit logger (`info`, `warn`, `error`, or `debug`).
- `STORAGE_PROVIDER` – Placeholder switch for future backends; the scaffold logs a warning and falls back to the in-memory map for any value other than `in-memory`.

## Running the Standalone Service
Install dependencies inside `memory-service/` and start the server:

```bash
cd memory-service
npm install
npm run dev
```

The service logs `ARCANOS Memory Service running on port <PORT>` when ready. Issue a commit request with the configured auth token to verify the flow:

```bash
curl -X POST "http://localhost:8080/api/memory/commit" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AUTH_TOKEN" \
  -d '{"content":"Hello memory"}'
```

Retrieve the stored record by its returned `id`:

```bash
curl "http://localhost:8080/api/memory/retrieve/$TRACE_ID" \
  -H "Authorization: Bearer $AUTH_TOKEN"
```

## Extending Beyond In-Memory Storage
The scaffold is intentionally simple so teams can substitute durable storage without rewriting the request surface. Implementers can replace the `persist` helper in `memoryService.js` with a database adapter or external API call while leaving the route, controller, and middleware topology intact. Until then, the `storageProvider` flag documents the intended extension point and prevents silent misconfiguration by printing a warning whenever a non-supported provider is selected.

## Observability Notes
- **Access logs**: Morgan emits structured access logs for every request through the Express logger configuration.
- **Audit logs**: The audit service decorates entries with timestamps, HTTP metadata, duration, and the active environment.
- **Health check**: `/health` returns `{ "status": "ok" }`, enabling basic uptime probes without touching stateful endpoints.

By understanding how this standalone Express scaffold fits together, contributors can confidently extend ARCANOS memory features, swap storage providers, or integrate the service into bespoke deployment targets without losing parity with the production guardrails.
