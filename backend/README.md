# Backend Implementation

This directory contains a standalone backend implementation for ARCANOS with a fine-tuned model.

## Files

- `index.js` - Main Express server with OpenAI integration
- `package.json` - Package configuration for standalone operation

## Features

- **Fine-tuned Model**: Uses `ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote`
- **Express Server**: Simple HTTP server with JSON middleware
- **OpenAI Integration**: Direct integration with OpenAI Chat Completions API
- **Environment Support**: Reads OPENAI_API_KEY from environment variables

## Usage

### Prerequisites

1. Set your OpenAI API key:
   ```bash
   export OPENAI_API_KEY="your-api-key-here"
   ```

2. Ensure you have access to the fine-tuned model `ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote`

### Running the Server

```bash
cd backend
node index.js
```

The server will start on port 5000 (or the PORT environment variable).

### Making Requests

```bash
curl -X POST http://localhost:5000/arcanos \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Analyze this logic problem: If all cats are animals, and some animals are pets, what can we conclude about cats?"}'
```

### Response Format

```json
{
  "reply": "Based on the given premises, we can conclude that all cats are animals (given directly). However, we cannot definitively conclude that cats are pets, as the second premise only states that some animals are pets, not all animals."
}
```

## Error Handling

The server includes error handling for:
- Missing OpenAI API key
- Invalid model access
- Malformed requests
- OpenAI API errors

Errors are returned in the format:
```json
{
  "error": "Error message here"
}
```