# System Architecture

## AI Control System
- **Fine-tuned Model** configured via the `AI_MODEL` environment variable.
- **AI-Controlled CRON** scheduling health checks (15 min), maintenance (6 hrs), and memory sync (4 hrs).
- **Intelligent Routing** where the AI determines request processing strategy.
- **Permission System** requiring AI approval before sensitive operations.

## Memory & Persistence
- **Primary Storage** uses PostgreSQL with automatic schema management.
- **Fallback Mode** stores memory in-memory when the database is unavailable.
- **Memory Types** include context, facts, preferences, decisions, and patterns.
