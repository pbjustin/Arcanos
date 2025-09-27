# 🌟 Arcanos Architecture Overview

> **Last Updated:** 2024-09-27 | **Version:** 1.2.0 | **Architecture Guide**

Arcanos is an AI-controlled backend system that pairs a fine-tuned GPT model with traditional web services. Built with TypeScript and Express, it relies on a PostgreSQL database for memory persistence with comprehensive fallback behaviors. The design goal is to give the model operational control over common tasks while providing standard HTTP endpoints for interaction.

## 📋 Architecture Documentation Self-Check

This overview includes:
- [x] Core AI-controlled architecture principles documented
- [x] Integration patterns with OpenAI SDK v5.16.0 specified
- [x] Database fallback behaviors clearly described
- [x] Worker system architecture explained
- [x] Configuration patterns and environment dependencies
- [x] Railway deployment compatibility considerations

Key capabilities include:

- **Fine-Tuned Model Integration** – Core logic routes through a fine-tuned GPT model. The model approves fallback to standard GPT models when necessary.
- **Intent-Based Routing** – Incoming requests are analyzed to detect intents such as `WRITE` or `AUDIT` and routed to specialized handlers.
- **Persistent Memory** – Conversation context and arbitrary key/value data are stored in PostgreSQL with an in-memory fallback for development.
- **OpenAI Assistants** – The backend can synchronize organization assistants so they are available at runtime.
- **AI-Controlled Workers** – Background tasks such as health checks and memory sync run only with AI approval.

In short, Arcanos acts as a comprehensive AI backend where the model plays an active role in system management while exposing a conventional API for clients.

For strict GPT-5 reasoning from Python, the project includes a companion module described in [ARCANOS_PYTHON_README.md](../ARCANOS_PYTHON_README.md). It enforces the fine-tuned model and automatically alerts a maintenance assistant on any failure.
