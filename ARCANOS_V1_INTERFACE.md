# ARCANOS V1 Safe Interface Implementation

This document describes the implementation of the `askArcanosV1_Safe` function as specified in the problem statement.

## Interface

```typescript
export async function askArcanosV1_Safe({
  message,
  domain = "general",
  useRAG = true,
  useHRC = true,
}: {
  message: string;
  domain?: string;
  useRAG?: boolean;
  useHRC?: boolean;
}): Promise<{ response: string }>;
```

## Implementation Details

### Core Components

1. **ArcanosModel Interface**: Defines the contract that all models must implement
   - `respond(message, options)`: Returns status and text response

2. **ArcanosModelWrapper**: Integrates OpenAI service with HRC and RAG functionality
   - Handles HRC validation
   - Retrieves RAG context from memory storage
   - Makes OpenAI API calls
   - Stores interactions for future RAG context

3. **getActiveModel()**: Returns the active model or null if no model is available
   - Checks for OpenAI API key
   - Checks for fine-tuned model configuration
   - Returns null if either is missing (fallback blocked)

### Safety Features

- **Fallback-proof**: Returns error messages instead of falling back to default models
- **Error handling**: Gracefully handles API failures and configuration issues
- **Validation**: Proper input validation and error responses

### API Endpoints

- **Direct Import**: `import { askArcanosV1_Safe } from './src/services/arcanos-v1-interface'`
- **HTTP Endpoint**: `POST /api/ask-v1-safe`
- **Main Export**: Available from main index file

## Usage Examples

### Direct Function Call
```javascript
const { askArcanosV1_Safe } = require('./dist/services/arcanos-v1-interface');

const result = await askArcanosV1_Safe({
  message: "Hello world",
  domain: "general",
  useRAG: true,
  useHRC: true
});

console.log(result.response);
```

### HTTP API Call
```bash
curl -X POST http://localhost:8080/api/ask-v1-safe \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello world","domain":"general"}'
```

## Error Responses

- **No Active Model**: `"❌ Error: No active model found. Fallback blocked."`
- **API/Model Error**: `"❌ Error: Fallback triggered or invalid model response."`

## Testing

Three test suites are provided:

1. **test-v1-unit.js**: Unit tests for core functionality
2. **test-v1-safe.js**: HTTP endpoint integration tests
3. **test-v1-comprehensive.js**: Complete interface validation

Run tests:
```bash
node test-v1-unit.js
node test-v1-safe.js
node test-v1-comprehensive.js
```

## Configuration

Required environment variables:
- `OPENAI_API_KEY`: OpenAI API key
- `FINE_TUNED_MODEL`: Fine-tuned model identifier
*Deprecated `OPENAI_FINE_TUNED_MODEL` is still accepted for backward compatibility*

Optional:
- `RUN_WORKERS`: Set to "true" to enable background workers
- `PORT`: Server port (default: 8080)