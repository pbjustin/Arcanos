# Arcanos Backend

A minimal TypeScript + Express backend for the Arcanos project.

## Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd Arcanos
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Environment configuration**
   ```bash
   cp .env.example .env
   # Edit .env with your actual values
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

## Running the Application

### Development Mode
```bash
npm run dev
```
This starts the server with hot reloading using tsx.

### Production Mode
```bash
npm run build
npm start
```

## API Endpoints

### General Endpoints
- `GET /health` - Health check endpoint
- `GET /api` - Welcome message with model status
- `POST /api/echo` - Echo endpoint for testing

### OpenAI Chat Endpoints
- `GET /api/model-status` - Get current model configuration
- `POST /api/ask` - Chat without fallback permission (asks for permission if fine-tuned model fails)
- `POST /api/ask-with-fallback` - Chat with fallback permission granted

### HRCCore Endpoints
- `POST /api/ask-hrc` - Message validation using HRCCore

### Memory Storage Endpoints
- `POST /api/memory` - Store a memory entry
- `GET /api/memory` - Retrieve all memory entries

### Chat Request Format
```json
{
  "message": "Your message here"
}
```
or
```json
{
  "messages": [
    {"role": "user", "content": "Your message here"},
    {"role": "assistant", "content": "Previous response"}
  ]
}
```

### Chat Response Format
```json
{
  "response": "AI response",
  "model": "model-used",
  "error": "error details if any",
  "fallbackRequested": true, // if permission needed for fallback
  "fallbackUsed": true, // if fallback model was used
  "timestamp": "2023-..."
}
```

### HRCCore Request Format
```json
{
  "message": "Text to validate"
}
```

### HRCCore Response Format
```json
{
  "success": true,
  "response": "Original message",
  "hrc": {
    "success": true,
    "data": null
  }
}
```

### Memory Request Format
```json
{
  "value": "Memory content to store"
}
```

### Memory Response Format
```json
{
  "success": true,
  "memory": {
    "id": "unique-id",
    "userId": "user",
    "sessionId": "session-id",
    "type": "context",
    "key": "key",
    "value": "stored value",
    "timestamp": "2023-...",
    "tags": [],
    "metadata": { ... }
  }
}
```

## OpenAI Model Behavior

The backend implements a permission-based fallback system for OpenAI models:

1. **Primary Model**: Always attempts to use your fine-tuned model first
2. **Permission Required**: If the fine-tuned model fails, `/api/ask` will ask for permission before falling back
3. **Fallback Allowed**: Use `/api/ask-with-fallback` when you grant permission to use the default model
4. **Error Transparency**: All errors are logged and returned to inform you of any issues

## Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 3000)
- `OPENAI_API_KEY` - Your OpenAI API key
- `OPENAI_FINE_TUNED_MODEL` - Your fine-tuned model name

## Project Structure

```
./src/index.ts              # Main server file
./src/routes/index.ts       # API routes
./src/services/openai.ts    # OpenAI service with permission-based fallback
package.json                # Dependencies and scripts
tsconfig.json               # TypeScript configuration
.gitignore                 # Git ignore rules
.env.example               # Environment variables template
README.md                  # This file
```
