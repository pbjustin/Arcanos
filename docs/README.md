# Arcanos Documentation Index

> **Last Updated:** 2025-02-14 | **Version:** 1.0.0

Welcome to the documentation hub for the Arcanos AI-assisted backend. This
index highlights the most relevant guides for getting started, configuring the
environment, and exploring advanced modules. It is now paired with
[`DOCUMENTATION_STATUS.md`](DOCUMENTATION_STATUS.md), which tracks which areas
still need love after each audit sweep.

---

## 🚀 Getting Started

1. **[Project Overview](arcanos-overview.md)** – Conceptual summary of the
   backend architecture.
2. **[Repository README](../README.md)** – Quick start instructions and API
   highlights.
3. **[Configuration Guide](CONFIGURATION.md)** – Environment variables and
   defaults.
4. **[API Reference](api/README.md)** – Endpoint catalogue and confirmation
   requirements.

---

## 🏗️ Architecture & System Design

- **[Backend Architecture](backend.md)** – Boot process, runtime components, and
  observability.
- **[Database Integration](DATABASE_INTEGRATION.md)** – Persistence and fallback
  behaviour.
- **[Routing Architecture](ARCANOS_ROUTING_ARCHITECTURE.md)** – Request routing
  and module dispatch.
- **[Secure Reasoning Engine](secure-reasoning-engine.md)** – Safety guardrails.
- **[AFOL Overview](AFOL_OVERVIEW.md)** – Failover orchestration and routing safeguards.

---

## 🌐 API Documentation

- **[API Overview](api/README.md)** – Summary of public routes.
- **[API Reference Details](api/API_REFERENCE.md)** – Request/response examples.
- **[Command Execution API](api/COMMAND_EXECUTION.md)** – `/api/commands`
  namespace documentation.
- **[Orchestration API](ORCHESTRATION_API.md)** – GPT‑5 orchestration shell
  controls.

---

## ⚙️ Configuration & Deployment

- **[Configuration Guide](CONFIGURATION.md)** – Environment matrix.
- **[Deployment Guide](deployment/DEPLOYMENT.md)** – Railway and production
  deployment.
- **[Environment Security Overview](environment-security-overview.md)** – Startup
  validation and safe-mode rules.
- **[Railway Compatibility](../RAILWAY_COMPATIBILITY_GUIDE.md)** – Platform
  specific considerations.

---

## 🧠 AI Modules & Memory

- **[Backend Sync Implementation](BACKEND_SYNC_IMPLEMENTATION.md)** – `/status`
  endpoints and GPT sync.
- **[Pinned Memory Guide](pinned-memory-guide.md)** – Persistent memory
  strategies.
- **[Universal Memory Guide](ai-guides/UNIVERSAL_MEMORY_GUIDE.md)** – Concepts
  for cross-session memory coordination.
- **[Standalone Memory Service](memory-service-standalone.md)** – Express
  scaffold for commit/retrieve workflows.
- **[RAG & Research](ai-guides/RESEARCH_MODULE.md)** – Retrieval augmented
  workflows.

> **Note:** Files inside `docs/ai-guides/` describe specialised modules and
> historical experiments. Confirm the referenced functionality exists in `src/`
> before relying on a given guide.

---

## 🛠️ Development & Operations

- **[Contributing Guide](../CONTRIBUTING.md)** – Development workflow and coding
  standards.
- **[PR Assistant README](PR_ASSISTANT_README.md)** – Automated review tooling.
- **[Diagnostics](audits-and-resiliency.md)** – Audit and resiliency reports.
- **[Backstage Booker Server](BACKSTAGE_BOOKER_SERVER.md)** – Legacy integration
  notes.

---

## 📊 Release Management

- **[Changelog](../CHANGELOG.md)** – Canonical version history.
- **[Documentation Status](DOCUMENTATION_STATUS.md)** – Live coverage tracker.
- **[Refactor Report](refactor-report.md)** – Architecture improvements.

## 🗃️ Archived / Retired Notes

The February 2025 review removed duplicate or stale files so we only maintain
one source of truth per topic. Pull historical context from Git history if
needed.

- `docs/changelog.md` – Duplicate of the root changelog and lagging by two
  releases.
- `docs/DOCUMENTATION_AUDIT_SUMMARY.md` – Snapshot from 2024 superseded by the
  living status report referenced above.

---

## Contribution Standards

- Include last-updated metadata when modifying documentation.
- Keep examples in sync with the Express routes under `src/routes/`.
- Run `npm test` after configuration changes to validate environment checks.
- Use descriptive commit messages and update the documentation index when adding
  or removing guides.

For questions or suggestions, open an issue or consult the maintainer guide in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md).
