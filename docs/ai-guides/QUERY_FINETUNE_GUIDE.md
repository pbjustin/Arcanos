# ARCANOS Fine-Tune Routing & Mirror Mode

## Overview
This implementation provides direct routing to the ARCANOS fine-tuned model (`REDACTED_FINE_TUNED_MODEL_ID`) with "Mirror Mode" behavior that returns raw, unformatted model responses.

## Features

### 1. Direct API Endpoint
**Endpoint:** `POST /query-finetune`
**Headers:** `Content-Type: application/json`
**Body:**
```json
{
  "query": "[User Prompt Here]",
  "metadata": {} // optional
}
```

**Response:**
```json
{
  "response": "Raw model response...",
  "model": "REDACTED_FINE_TUNED_MODEL_ID",
  "success": true,
  "timestamp": "2025-07-21T06:50:04.715Z",
  "metadata": {}
}
```

### 2. Prefix-Based Routing
Use the `query-finetune:` prefix with any message to activate direct routing:

**Endpoint:** `POST /`
**Headers:** `Content-Type: application/json`
**Body:**
```json
{
  "message": "query-finetune: [your prompt here]"
}
```

**Response:** Raw text response (Mirror Mode)
```
Raw model response without JSON wrapper...
```

## Usage Examples

### Direct Endpoint Examples
```bash
# Basic query
curl -X POST http://localhost:8080/query-finetune \
  -H "Content-Type: application/json" \
  -d '{"query": "What is ARCANOS?"}'

# With metadata
curl -X POST http://localhost:8080/query-finetune \
  -H "Content-Type: application/json" \
  -d '{"query": "Explain the memory architecture", "metadata": {"session": "test"}}'
```

### Prefix-Based Examples
```bash
# WWE simulation
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -d '{"message": "query-finetune: Simulate a Raw segment between Cody Rhodes and The Rock."}'

# Universe management
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -d '{"message": "query-finetune: List current title holders in my WWE Universe."}'

# System inquiry
curl -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -d '{"message": "query-finetune: Explain the memory architecture being used."}'
```

## Mirror Mode Behavior

When using the `query-finetune:` prefix:
- **No GPT-4-Turbo interpretation** or shell processing
- **Raw model output** returned exactly as generated
- **No JSON wrapper** - plain text response
- **Direct fine-tuned model access** without additional layers

Perfect for:
- Debugging model responses
- Accuracy testing
- Model-pure user experience
- Integration with external tools

## Technical Implementation

### Prefix Detection
- **Case insensitive:** `query-finetune:`, `QUERY-FINETUNE:`, `Query-FineTune:`
- **Whitespace tolerant:** Handles extra spaces before/after prefix and query
- **Error handling:** Returns 400 for empty queries after prefix

### Model Configuration
- **Model ID:** `REDACTED_FINE_TUNED_MODEL_ID`
- **Service:** OpenAI Fine-Tune API
- **Fallback:** Graceful error handling when service unavailable

### Integration Points
- Works with existing ARCANOS routing system
- Preserves normal message routing for non-prefixed messages
- Compatible with Railway, GitHub Actions, Vercel functions
- Suitable for Postman, curl scripts, and Copilot integration

## Testing

Run the comprehensive test suite:
```bash
node test-query-finetune.js
```

This validates:
- Direct endpoint functionality
- Prefix-based routing
- Mirror mode behavior
- Error handling
- Case sensitivity
- Model configuration
- Regular message routing preservation

## Environment Configuration

Required environment variables:
```
OPENAI_API_KEY=your-openai-api-key
FINE_TUNED_MODEL=REDACTED_FINE_TUNED_MODEL_ID
```

## Error Handling

The implementation includes robust error handling for:
- Missing queries
- Empty queries after prefix
- OpenAI API failures
- Invalid JSON requests
- Network timeouts

All errors return appropriate HTTP status codes and descriptive error messages.