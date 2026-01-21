# Setup and Quick Start

## Prerequisites
- Node.js 18+
- npm 8+
- PostgreSQL (optional; the service falls back to in-memory storage)

## Installation
```bash
git clone <repository-url>
cd Arcanos
npm install
cp .env.example .env
# Edit .env with your OpenAI API key
npm run build
npm start
```

## Smoke Tests
After starting the server locally, verify key endpoints:
```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, how are you?"}'

# Generate an image (prompt is refined by the fine-tuned model)
curl -X POST http://localhost:8080/image \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A sunset over the mountains"}'

# Fetch WWE Universe roster from Notion
curl http://localhost:8080/booker/roster
```
