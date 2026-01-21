# Core API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | POST | Main chat with intent routing |
| `/api/ask` | POST | Fine-tuned model chat (no fallback) |
| `/api/ask-with-fallback` | POST | Chat with GPT fallback permission |
| `/api/ask-v1-safe` | POST | Safe interface with RAG/HRC features |
| `/api/arcanos` | POST | Intent-based routing (WRITE/AUDIT) |
| `/memory/save` | POST | Store memory entries |
| `/memory/load` | GET | Retrieve memory entries |
| `/memory/all` | GET | Get all memory entries |
| `/api/ask-hrc` | POST | Message validation using the HRC overlay system |
| `/api/diagnostics` | POST | Natural language system diagnostics |
| `/api/canon/files` | GET/POST | Canon storyline file management |
| `/health` | GET | Health check endpoint |
