# Arcanos Backend Overview

Arcanos is an AI-controlled TypeScript backend that combines fine-tuned OpenAI model integration, intelligent routing, and persistent memory storage. The system is orchestrated entirely by an AI worker capable of handling scheduling, memory management, and advanced API interactions.

## Core Features
- **AI-Managed Operations** driven by fine-tuned GPT models (default `REDACTED_FINE_TUNED_MODEL_ID`).
- **Intelligent Memory System** with PostgreSQL persistence and in-memory fallback for resilience.
- **OpenAI SDK v5.16.0** providing streaming, function calling, assistants, and GPT-5 compatibility.
- **Image Generation** through DALL·E with AI-refined prompts.
- **Notion Database Sync** to import WWE Universe roster data using the official SDK.
- **Worker System** for AI-controlled CRON scheduling of maintenance, health checks, and background tasks.
- **Hallucination-Resistant Core (HRC)** for reliability scoring across generated responses.
- **Modern TypeScript Architecture** built on Express.js with comprehensive error handling.
- **Railway-Optimized Deployment** featuring health monitoring and graceful shutdown.

## Environment Safety Snapshot
Arcanos includes an environment safety layer that validates deployment hosts, performs sandboxed rehearsals, and toggles into a cautious “safe mode” when the runtime looks unfamiliar. Startup logs and the `/health` endpoint report whether the system is running in a trusted environment. For a full breakdown, see [`docs/environment-security-overview.md`](../environment-security-overview.md).
