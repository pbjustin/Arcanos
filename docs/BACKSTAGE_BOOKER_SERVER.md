# BackstageBooker Server

The BackstageBooker server exposes a minimal REST API for managing a WWE Universe simulation. It persists data in a PostgreSQL database and uses the OpenAI SDK to generate booking decisions.

## Features
- **Save/Load** arbitrary JSON data (roster, storylines, rivalries, matches).
- **ARCANOS Powered** booking via OpenAI's fine‑tuned model.
- **PostgreSQL** persistence with automatic upsert behaviour.

## Setup
1. Start a PostgreSQL instance and set the `DATABASE_URL` environment variable.
2. Create the `backstage_booker` table:
   ```sql
   CREATE TABLE backstage_booker (
       id SERIAL PRIMARY KEY,
       timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
       key TEXT UNIQUE,
       value JSONB
   );
   ```
3. Ensure `OPENAI_API_KEY` is set for access to the ARCANOS model.
4. Install dependencies and run the server:
   ```bash
   npm install
   node server.js
   ```

## API Endpoints
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/save` | Save JSON payload under a key. |
| `GET`  | `/load/:key` | Load data by key. |
| `POST` | `/book` | Generate booking via OpenAI and persist result under `latest_booking`. |
| `GET`  | `/health` | Health check. |

The `/book` endpoint accepts a JSON body with a `prompt` field. The generated content is stored under `latest_booking` in the database.

## Example
```bash
curl -X POST http://localhost:3000/book \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Book a main event"}'
```

The response includes the model's booking decision and saves it in the database for later retrieval.
