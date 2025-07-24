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
- `POST /memory/save` - Save memory key-value pair
- `GET /memory/load` - Load memory by key
- `GET /memory/all` - Retrieve all memory entries
- `DELETE /memory/clear` - Clear memory entries
- `GET /memory/health` - Memory system health check

### Canon Management
- `GET /api/canon/files` - List all canon storyline files
- `GET /api/canon/files/:filename` - Read specific canon file
- `POST /api/canon/files/:filename` - Write/update canon file

### Container Management
- `GET /api/containers/status` - List Docker container status
- `POST /api/containers/:name/:action` - Control containers (start/stop/restart)

### Diagnostics & Monitoring
- `POST /api/diagnostics` - Natural language diagnostic commands
- `GET /system/diagnostics` - System diagnostics information
- `GET /system/workers` - Worker status information
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

### AI-Controlled System Architecture
The backend implements **full AI operational control** where the fine-tuned model manages system operations:
- **AI-Controlled CRON Workers** - All background tasks require AI approval
- **JSON Instruction System** - Service logic converted to AI-interpretable instructions
- **Model Control Hooks** - Unified control interface for AI operational decisions
- **Intelligent Resource Management** - AI decides when to execute maintenance, health checks, and memory operations

### Intent-Based AI Routing
The backend implements intelligent intent detection that routes requests to specialized processors:
- **ARCANOS:WRITE** - Creative writing and content generation
- **ARCANOS:AUDIT** - Code review and analysis tasks
- **General Processing** - Standard chat and Q&A

### Fine-Tuned Model Integration
- **Primary Model**: `ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106`
- **AI System Control**: Model controls CRON workers and operational decisions
- **Permission-Based Fallback**: AI approval required for standard GPT models
- **Error Transparency**: Comprehensive error logging and user feedback
- **🔁 Routing Override**: Shell command to force all prompts through fine-tuned model

### OpenAI Assistants Integration
- **Automatic Sync**: All organization assistants synced every 30 minutes
- **Runtime Lookup**: Assistants available via `config/assistants.json`
- **Name Normalization**: `UPPERCASE_WITH_UNDERSCORES` format for consistent access
- **Full Integration**: Assistant tools and instructions preserved and accessible

### Memory & Context Management
- **PostgreSQL Backend**: Persistent storage with automatic schema management
- **In-Memory Fallback**: Graceful degradation when database unavailable
- **Session Tracking**: User and session-based context preservation
- **Canon Management**: Storyline file storage and retrieval
- **AI-Controlled Memory Sync**: Automatic memory snapshots every 4 hours

### System Health & Monitoring
- **AI-Controlled Health Checks**: Fine-tuned model approves health monitoring
- **Comprehensive Diagnostics**: Natural language diagnostic commands
- **Real-time Monitoring**: Background worker status and health metrics
- **Sleep/Wake Cycles**: Configurable low-power operation periods
- **Container Management**: Docker integration for service control

### Fine-Tuning Pipeline
- **Modular Training**: Upload and process .jsonl training data
- **Incremental Refinement**: Continue fine-tuning existing models
- **Progress Monitoring**: Real-time job tracking and status logging
- **Human-Controlled**: Manual triggers for staged model improvement

## Environment Variables

### Required Variables
- `OPENAI_API_KEY` - Your OpenAI API key
- `FINE_TUNED_MODEL` - Your fine-tuned model name

### Server Configuration
- `NODE_ENV` - Environment (development/production) (default: development)
- `PORT` - Server port (default: 8080)

### Database Configuration
- `DATABASE_URL` - PostgreSQL connection string (optional, uses in-memory fallback if not set)

### Worker Configuration
- `RUN_WORKERS` - Set to `true` (or `1`) to enable AI-controlled background workers. Use `false` (default) if you only need the memory API and want the server to keep running without background jobs.
- `SERVER_URL` - Server URL for health checks (default: http://localhost:8080)

### Sleep & Wake Configuration
- `SLEEP_ENABLED` - Enable sleep mode (default: false)
- `SLEEP_START` - Sleep start time in HH:MM format (default: 02:00)
- `SLEEP_DURATION` - Sleep duration in hours (default: 7)
- `SLEEP_TZ` - Sleep timezone (default: UTC)

### Optional Configuration
- `GPT_TOKEN` - Authorization token for GPT diagnostic access
- `ARCANOS_API_TOKEN` - Token for memory and diagnostic endpoints
- `ASK_CONCURRENCY_LIMIT` - Max concurrent `/api/ask` requests (default: 3)
- `MODEL_ID` - Base model for fine-tuning pipeline (default: gpt-3.5-turbo)

Example memory request with token:

```bash
curl -X GET http://localhost:8080/api/memory/health \
  -H "Authorization: Bearer $ARCANOS_API_TOKEN"
```

## 📚 Documentation

- **[🚀 Setup Guide](./SETUP_GUIDE.md)** - Quick start instructions
- **[🔁 Fine-Tune Routing Override](./FINETUNE_ROUTING_OVERRIDE.md)** - Shell command to force all prompts through fine-tuned model
- **[📖 Prompt API Guide](./PROMPT_API_GUIDE.md)** - Comprehensive guide to using prompts with all API endpoints
- **[💡 Practical Examples](./PROMPT_API_EXAMPLES.md)** - Ready-to-use examples and code snippets
- **[🔧 Test Script](./test-api-endpoints.sh)** - Automated endpoint testing
- **[🤖 Fine-Tuning Pipeline](./FINETUNE_PIPELINE.md)** - Modular system for continuing fine-tuning of OpenAI models
- **[⚡ Concurrency Test](./test-concurrency-limit.js)** - Verify parallel request handling

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
./test-concurrency-limit.js
```

### Key Endpoints for AI Interaction
- `POST /` - Main chat with intent routing (simplest interface)
- `POST /api/ask` - Direct fine-tuned model interaction
- `POST /api/ask-with-fallback` - AI chat with GPT-4 fallback
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT)
- `POST /memory/save` - Save memory entries for context

### Diagnostic & Management
- `POST /api/diagnostics` - Natural language system commands
- `GET /system/workers` - Background process monitoring (verify workers after setting `RUN_WORKERS=true`)
- `GET /system/diagnostics` - Comprehensive system diagnostics
- `GET /sync/diagnostics` - GPT-accessible system metrics
- `GET /api/containers/status` - Docker container management
- `GET /api/canon/files` - Storyline file management
- `GET /api/model-status` - Current model configuration
- `GET /api/model/info` - Detailed model metadata

### Fine-Tuning Pipeline
- `./upload_jsonl.sh [file.jsonl]` - Upload training data to OpenAI
- `./continue_finetune.sh [file-id] [model]` - Start fine-tuning jobs
- `./track_job.sh [--follow]` - Monitor training progress
- `./test-finetune-pipeline.sh` - Test pipeline components

### Railway Deployment (Memory Only)
If you just need the memory API, set `RUN_WORKERS=false` in your `.env` file. The server
will start an Express app on `process.env.PORT || 8080` and keep itself alive with a
minimal interval so Railway doesn't terminate the container. Run:

```bash
npm run build
npm start
# test the health endpoint
curl $PORT/api/memory/health
```

## Project Structure

```
./src/index.ts              # Main server entry point (TypeScript)
./src/routes/
  ├── index.ts              # Main API routes and endpoints
  ├── ask.ts                # Ask route implementation
  ├── canon.ts              # Canon storyline file management
  ├── containers.ts         # Docker container management
  ├── memory.ts             # Memory storage routes
  ├── system.ts             # System routes
  ├── query-router.ts       # Query routing
  ├── job-limit.ts          # Job limiting functionality
  ├── job-queue.ts          # Job queue management
  └── plugins.ts            # Plugin routes
./src/services/
  ├── openai.ts             # OpenAI service with fallback handling
  ├── arcanos-router.ts     # Intent-based routing service
  ├── arcanos-v1-interface.ts # Safe AI interface
  ├── diagnostics.ts        # System diagnostics service
  ├── cron-worker.ts        # Background worker management
  ├── database.ts           # Database service
  ├── database-connection.ts # Database connection management
  └── server.ts             # Server utilities
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
