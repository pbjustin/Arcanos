# BackstageBooker Server v2.0

BackstageBooker v2.0 exposes a minimal REST API for managing a WWE Universe simulation. It persists data in PostgreSQL, uses the OpenAI SDK to generate booking decisions, **and automatically reflects on each saved storyline**.

## Features
- **ARCANOS Powered** booking via OpenAI's fine‑tuned model.
- **Automatic Reflection** on every generated storyline, validating consistency and suggesting improvements.
- **PostgreSQL** persistence with automatic upsert behaviour.

## Setup
1. Start a PostgreSQL instance and set the `DATABASE_URL` environment variable.
2. Create the `backstage_booker` table:
   ```sql
   CREATE TABLE backstage_booker (
       id SERIAL PRIMARY KEY,
       timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
       key TEXT UNIQUE,
       storyline JSONB,
       reflection TEXT
   );
   ```
3. Ensure `OPENAI_API_KEY` is set for access to the ARCANOS model.
4. Install dependencies and run the server:
   ```bash
   npm install
   npm run build && npm start
   ```
   The backstage functionality is now integrated into the main ARCANOS server at `/backstage/*` endpoints.

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/book` | Generate a storyline via OpenAI, reflect on it, and persist the result under `latest_storyline`. |
| `GET`  | `/load/:key` | Load stored storyline and reflection by key. |
| `GET`  | `/health` | Health check. |

The `/book` endpoint accepts a JSON body with a `prompt` field. The generated storyline and its reflection are stored in the database and returned in the response.

## Example
```bash
curl -X POST http://localhost:3000/book \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Book a main event"}'
```

The response includes the model's booking decision and a reflective analysis, both saved for later retrieval.
