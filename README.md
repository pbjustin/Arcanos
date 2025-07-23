# Arcanos Backend

A comprehensive TypeScript + Express backend for the Arcanos AI project, featuring fine-tuned OpenAI model integration, intent-based routing, and persistent memory storage.

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
   # Quick setup (recommended)
   ./setup-dev.sh
   
   # Manual setup
   cp .env.example .env
   # Edit .env with your actual values
   ```

4. **Build the project**
   ```bash
   npm run build
   ```

## Database Setup

The application uses PostgreSQL for persistent memory storage. You have several options:

1. **Quick Development Setup (Docker)**
   ```bash
   ./setup-dev.sh  # Automatically sets up PostgreSQL with Docker
   ```

2. **Manual Docker Setup**
   ```bash
   docker-compose up -d postgres  # Start PostgreSQL database
   ```

3. **Use existing PostgreSQL**
   Edit `.env` and set `DATABASE_URL` to your PostgreSQL connection string.

4. **In-memory fallback**
   Comment out `DATABASE_URL` in `.env` to use in-memory storage (data won't persist).

## Running the Application

### Development Mode
```bash
npm run dev
```
This starts the server with hot reloading and 7GB memory allocation for optimal performance.

### Production Mode
```bash
npm run build
npm start
```

## API Endpoints

### Core Endpoints
- `GET /health` - Health check endpoint
- `GET /` - API status message
- `POST /` - Main chat endpoint with intent-based routing
- `POST /ask` - Simple query processing endpoint
- `POST /webhook` - GitHub webhook integration

### AI Chat Endpoints
- `GET /api` - Welcome message with model status
- `POST /api/echo` - Echo endpoint for testing
- `POST /api/ask` - Fine-tuned model chat (no fallback)
- `POST /api/ask-with-fallback` - Chat with GPT fallback permission
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT detection)
- `GET /api/model-status` - Get current model configuration
- `GET /api/model/info` - Detailed model metadata

### Validation & Processing
- `POST /api/ask-hrc` - Message validation using HRCCore

### Memory & Storage
- `POST /api/memory` - Store a memory entry
- `GET /api/memory` - Retrieve all memory entries

### Canon Management
- `GET /api/canon/files` - List all canon storyline files
- `GET /api/canon/files/:filename` - Read specific canon file
- `POST /api/canon/files/:filename` - Write/update canon file

### Container Management
- `GET /api/containers/status` - List Docker container status
- `POST /api/containers/:name/:action` - Control containers (start/stop/restart)

### Diagnostics & Monitoring
- `POST /api/diagnostics` - Natural language diagnostic commands
- `GET /api/workers/status` - Background worker status
- `GET /sync/diagnostics` - GPT-accessible system metrics

### Request Formats

#### Chat Endpoints (`/api/ask`, `/api/ask-with-fallback`)
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

#### Intent-Based Routing (`/api/arcanos`)
```json
{
  "message": "Your message here",
  "domain": "general",
  "useRAG": true,
  "useHRC": true
}
```

#### Simple Query (`/ask`)
```json
{
  "query": "Your query here",
  "mode": "logic"
}
```

#### Memory Storage (`/api/memory`)
```json
{
  "value": "Memory content to store"
}
```

#### Diagnostics (`/api/diagnostics`)
```json
{
  "command": "Check available memory"
}
```

#### Canon File Management (`/api/canon/files/:filename`)
```json
{
  "content": "File content to store"
}
```

### Response Formats

#### Standard Chat Response
```json
{
  "response": "AI response",
  "model": "model-used",
  "error": "error details if any",
  "timestamp": "2023-..."
}
```

#### Intent Router Response
```json
{
  "success": true,
  "response": "AI response",
  "intent": "WRITE",
  "confidence": 0.95,
  "reasoning": "Intent analysis details",
  "model": "model-used",
  "metadata": { ... }
}
```

#### Memory Response
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

## Features

### Intent-Based AI Routing
The backend implements intelligent intent detection that routes requests to specialized processors:
- **ARCANOS:WRITE** - Creative writing and content generation
- **ARCANOS:AUDIT** - Code review and analysis tasks
- **General Processing** - Standard chat and Q&A

### Fine-Tuned Model Integration
- **Primary Model**: Custom fine-tuned GPT-3.5 Turbo model
- **Fallback System**: Permission-based GPT-4 fallback for reliability
- **Error Transparency**: Comprehensive error logging and user feedback
- **🔁 Routing Override**: Shell command to force all prompts through fine-tuned model

### Memory & Context Management
- **Persistent Storage**: Memory entries with tags and metadata
- **Session Tracking**: User and session-based context preservation
- **Canon Management**: Storyline file storage and retrieval

### Container & System Management
- **Docker Integration**: Monitor and control application containers
- **System Diagnostics**: Natural language diagnostic commands
- **Real-time Monitoring**: Background worker status and health metrics

### Fine-Tuning Pipeline
- **Modular Training**: Upload and process .jsonl training data
- **Incremental Refinement**: Continue fine-tuning existing models
- **Progress Monitoring**: Real-time job tracking and status logging
- **Human-Controlled**: Manual triggers for staged model improvement

## Environment Variables

- `NODE_ENV` - Environment (development/production)
- `PORT` - Server port (default: 8080)
- `OPENAI_API_KEY` - Your OpenAI API key
- `FINE_TUNED_MODEL` - Your fine-tuned model name
- `RUN_WORKERS` - Set to `true` to enable background workers and audit tasks
- `SERVER_URL` - Server URL for health checks
- `GPT_TOKEN` - Authorization token for GPT diagnostic access

## 📚 Documentation

- **[🚀 Setup Guide](./SETUP_GUIDE.md)** - Quick start instructions
- **[🔁 Fine-Tune Routing Override](./FINETUNE_ROUTING_OVERRIDE.md)** - Shell command to force all prompts through fine-tuned model
- **[📖 Prompt API Guide](./PROMPT_API_GUIDE.md)** - Comprehensive guide to using prompts with all API endpoints
- **[💡 Practical Examples](./PROMPT_API_EXAMPLES.md)** - Ready-to-use examples and code snippets
- **[🔧 Test Script](./test-api-endpoints.sh)** - Automated endpoint testing
- **[🤖 Fine-Tuning Pipeline](./FINETUNE_PIPELINE.md)** - Modular system for continuing fine-tuning of OpenAI models

## Quick Reference

### Essential Commands
```bash
# Setup
npm install
cp .env.example .env
# Edit .env with your OpenAI credentials

# Run
npm run build
npm start

# Test
./test-api-endpoints.sh
```

### Key Endpoints for AI Interaction
- `POST /` - Main chat with intent routing (simplest interface)
- `POST /api/ask` - Direct fine-tuned model interaction
- `POST /api/ask-with-fallback` - AI chat with GPT-4 fallback
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT)
- `POST /api/memory` - Context storage for better responses

### Diagnostic & Management
- `POST /api/diagnostics` - Natural language system commands
- `GET /api/workers/status` - Background process monitoring (verify workers after setting `RUN_WORKERS=true`)
- `GET /api/containers/status` - Docker container management
- `GET /api/canon/files` - Storyline file management

### Fine-Tuning Pipeline
- `./upload_jsonl.sh [file.jsonl]` - Upload training data to OpenAI
- `./continue_finetune.sh [file-id] [model]` - Start fine-tuning jobs
- `./track_job.sh [--follow]` - Monitor training progress
- `./test-finetune-pipeline.sh` - Test pipeline components

## Project Structure

```
./src/index.ts              # Main server entry point (TypeScript)
./src/routes/
  ├── index.ts              # Main API routes and endpoints
  ├── ask.ts                # Example ask route implementation
  ├── canon.ts              # Canon storyline file management
  └── containers.ts         # Docker container management
./src/services/
  ├── openai.ts             # OpenAI service with fallback handling
  ├── arcanos-router.ts     # Intent-based routing service
  ├── arcanos-v1-interface.ts # Safe AI interface
  ├── diagnostics.ts        # System diagnostics service
  ├── cron-worker.ts        # Background worker management
  └── endpoint-logger.ts    # API endpoint logging
./src/modules/hrc/          # HRCCore validation module
./src/storage/              # Memory and file storage systems
./src/handlers/             # Request handlers
./index.js                  # Legacy entry point (JavaScript)
./package.json              # Dependencies and scripts
./tsconfig.json             # TypeScript configuration
./.env.example              # Environment variables template
./docs/                     # Additional documentation
./test-*.js                 # Various test scripts
./README.md                 # This file
```
