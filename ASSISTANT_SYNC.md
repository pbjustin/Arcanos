# OpenAI Assistants Sync

This feature automatically syncs all OpenAI Assistants from your organization using the OpenAI API and makes them available for runtime lookup.

## Overview

The assistant sync system:
- Fetches all assistants from your OpenAI organization
- Normalizes assistant names to uppercase with underscores
- Saves the data to `config/assistants.json` for runtime lookup
- Runs automatically every 30 minutes via CRON (at :15 and :45 minutes past the hour)

## Setup

1. **Environment Variables**: Ensure your `.env` file contains:
   ```
   OPENAI_API_KEY=your-openai-api-key-here
   ```

2. **Configuration**: The sync service will automatically create the `config/assistants.json` file.

## Name Normalization

Assistant names are normalized according to these rules:
- Convert to uppercase
- Replace spaces with underscores
- Remove special characters (except alphanumeric and spaces)
- Multiple consecutive spaces become a single underscore

### Examples:
- `"Arcanos Runtime Companion"` → `"ARCANOS_RUNTIME_COMPANION"`
- `"Test Assistant-123"` → `"TEST_ASSISTANT123"`
- `"My AI Helper (v2)"` → `"MY_AI_HELPER_V2"`

## Data Format

The `config/assistants.json` file contains a map where:
- **Keys**: Normalized assistant names
- **Values**: Assistant data objects

```json
{
  "ARCANOS_RUNTIME_COMPANION": {
    "id": "asst_abc123",
    "name": "Arcanos Runtime Companion",
    "instructions": "You are a helpful assistant...",
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "example_function",
          "description": "An example function"
        }
      }
    ],
    "model": "gpt-4"
  }
}
```

## API Endpoints

### GET /api/assistants
Get all synced assistants.

**Response:**
```json
{
  "success": true,
  "count": 1,
  "assistants": { /* assistant map */ },
  "assistantNames": ["ARCANOS_RUNTIME_COMPANION"],
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### POST /api/assistants/sync
Manually trigger an assistant sync.

**Response:**
```json
{
  "success": true,
  "message": "Assistant sync completed successfully",
  "count": 1,
  "assistantNames": ["ARCANOS_RUNTIME_COMPANION"],
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### GET /api/assistants/:name
Get a specific assistant by normalized name.

**Example:** `GET /api/assistants/ARCANOS_RUNTIME_COMPANION`

**Response:**
```json
{
  "success": true,
  "assistant": {
    "id": "asst_abc123",
    "name": "Arcanos Runtime Companion",
    "instructions": "You are a helpful assistant...",
    "tools": [...],
    "model": "gpt-4"
  },
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

## CRON Schedule

The assistant sync runs automatically every 30 minutes:
- **Schedule**: `15,45 * * * *` (at 15 and 45 minutes past every hour)
- **AI Controlled**: The sync is subject to AI approval via the existing model control hooks
- **Logging**: All sync activities are logged with `[AI-ASSISTANT-SYNC]` prefix

## Usage in Code

```typescript
import { openAIAssistantsService } from './services/openai-assistants';

// Get all assistant names
const names = await openAIAssistantsService.getAssistantNames();

// Get specific assistant
const assistant = await openAIAssistantsService.getAssistant('ARCANOS_RUNTIME_COMPANION');

// Manual sync
const syncedAssistants = await openAIAssistantsService.syncAssistants();
```

## Error Handling

- If `OPENAI_API_KEY` is missing, the service will initialize in limited mode
- Sync failures are logged and reported via worker status
- API endpoints return appropriate error responses with timestamps
- The system gracefully handles missing config files

## Integration with Existing System

This feature integrates seamlessly with the existing Arcanos architecture:
- Uses the same CRON system as other scheduled tasks
- Follows the AI-controlled execution pattern
- Integrates with the worker status service
- Uses the existing OpenAI service configuration patterns