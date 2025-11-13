# Arcanos API Practical Examples

Ready-to-use cURL snippets and client templates for exercising the current API
surface.

## Setup Test Environment

```bash
cp .env.example .env
# Edit .env with your OPENAI_API_KEY and OPENAI_MODEL
npm install
npm run build
npm start
```

---

## Basic Connectivity Tests

```bash
# Health + readiness
curl http://localhost:8080/health
curl http://localhost:8080/readyz

# Smoke probe
curl http://localhost:8080/api/test

# Worker inventory
curl http://localhost:8080/workers/status
```

---

## AI Interaction Examples

### Primary chat (`/ask`)
```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{
        "prompt": "Compare REST and GraphQL architectures",
        "sessionId": "doc-demo"
      }'
```

### Flexible JSON (`/api/ask`)
```bash
curl -X POST http://localhost:8080/api/ask \
  -H "Content-Type: application/json" \
  -d '{
        "message": "Summarize the current sprint goals",
        "domain": "product",
        "useRAG": true
      }'
```

### Diagnostic orchestration (`/arcanos`)
```bash
curl -X POST http://localhost:8080/arcanos \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "userInput": "Audit the staging environment and report degraded services",
        "sessionId": "ops-shift"
      }'
```

### Programmatic JSON (`/api/arcanos/ask`)
```bash
curl -X POST http://localhost:8080/api/arcanos/ask \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"prompt":"Ping"}'
```

### Safety scoring (`/api/ask-hrc`)
```bash
curl -X POST http://localhost:8080/api/ask-hrc \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"message": "Ship unreviewed code now"}'
```

---

## Memory and Context Examples

```bash
# Save
curl -X POST http://localhost:8080/api/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key":"user:pref","value":{"lang":"TypeScript"}}'

# Load
curl "http://localhost:8080/api/memory/load?key=user:pref"

# Bulk
curl -X POST http://localhost:8080/api/memory/bulk \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{
        "operations": [
          {"type":"save","key":"project:focus","value":{"name":"Atlas"}},
          {"type":"delete","key":"project:legacy"}
        ]
      }'
```

---

## RAG & Research

```bash
# Fetch document by URL
curl -X POST http://localhost:8080/rag/fetch \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/postmortem"}'

# Query stored corpus
curl -X POST http://localhost:8080/rag/query \
  -H "Content-Type: application/json" \
  -d '{"query":"List remediation items"}'

# Research module
curl -X POST http://localhost:8080/commands/research \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"topic":"LLM guardrails"}'
```

---

## Worker Automation

```bash
# Dispatch ARCANOS queue
curl -X POST http://localhost:8080/workers/run/arcanos \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"input":"Summarize pending incidents"}'

# Run the memory synchronizer manually
curl -X POST http://localhost:8080/workers/run/worker-memory \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes"
```

---

## Assistant Registry & Codebase APIs

```bash
# Inspect assistants
curl http://localhost:8080/api/assistants

# Force sync
curl -X POST http://localhost:8080/api/assistants/sync -H "Content-Type: application/json"

# Browse repository tree
curl "http://localhost:8080/api/codebase/tree?path=src"

# Fetch file snippet
curl "http://localhost:8080/api/codebase/file?path=src/server.ts&startLine=1&endLine=60"
```

---

## JavaScript Client Skeleton

```javascript
import axios from 'axios';

class ArcanosClient {
  constructor(baseURL = 'http://localhost:8080') {
    this.http = axios.create({ baseURL });
  }

  async ask(prompt, sessionId) {
    const { data } = await this.http.post('/ask', { prompt, sessionId });
    return data;
  }

  async arcanos(userInput, sessionId, confirmed = false) {
    const headers = confirmed ? { 'x-confirmed': 'yes' } : {};
    const { data } = await this.http.post('/arcanos', { userInput, sessionId }, { headers });
    return data;
  }

  async saveMemory(key, value) {
    const { data } = await this.http.post('/api/memory/save', { key, value }, {
      headers: { 'x-confirmed': 'yes' }
    });
    return data;
  }
}
```

---

## Python Client Skeleton

```python
import requests

class ArcanosClient:
    def __init__(self, base_url: str = "http://localhost:8080"):
        self.base_url = base_url

    def ask(self, prompt: str, session_id: str | None = None):
        resp = requests.post(f"{self.base_url}/ask", json={"prompt": prompt, "sessionId": session_id})
        resp.raise_for_status()
        return resp.json()

    def arcanos(self, user_input: str, session_id: str | None = None):
        resp = requests.post(
            f"{self.base_url}/arcanos",
            json={"userInput": user_input, "sessionId": session_id},
            headers={"x-confirmed": "yes"}
        )
        resp.raise_for_status()
        return resp.json()

    def save_memory(self, key: str, value: dict):
        resp = requests.post(
            f"{self.base_url}/api/memory/save",
            json={"key": key, "value": value},
            headers={"x-confirmed": "yes"}
        )
        resp.raise_for_status()
        return resp.json()
```

These snippets align with the current TypeScript routes and validate that the
backend responds with the latest payload formats.
