# Arcanos Backend

A comprehensive TypeScript + Express backend for the Arcanos AI project, featuring fine-tuned OpenAI model integration, intent-based routing, and persistent memory storage.

Arcanos is designed as an **AI-managed backend**. A fine-tuned GPT model controls background workers, decides when to run maintenance tasks, and processes incoming requests through an intent router. Persistent memory is stored in PostgreSQL with an in-memory fallback so the system can maintain context even if the database is unavailable. In short, Arcanos provides a conventional HTTP API that is orchestrated by an AI model.

# Arcanos Backend

A modern TypeScript + Express backend for the Arcanos AI project, featuring OpenAI integration, clean API routing, and comprehensive error handling.

Arcanos provides a clean HTTP API for AI-powered interactions with robust error handling, graceful degradation, and modern Node.js best practices.

## ✅ Recent Refactoring (v1.0.0)

**Major cleanup and modernization completed:**
- ✅ Consolidated to single TypeScript-based server implementation
- ✅ Improved OpenAI SDK integration with graceful fallbacks
- ✅ Enhanced error handling and request validation  
- ✅ Organized project structure (docs moved to `docs/`, utilities to `utils/`)
- ✅ Modern TypeScript configuration with strict typing
- ✅ Dependency cleanup and optimization

## Quick Start

### Prerequisites
- Node.js 18+ 
- npm 8+

### Installation & Setup

1. **Clone and install**
   ```bash
   git clone <repository-url>
   cd Arcanos
   npm install
   ```

2. **Environment setup**
   ```bash
   cp .env.example .env
   # Edit .env and add your OpenAI API key:
   # OPENAI_API_KEY=your-api-key-here
   ```

3. **Build and run**
   ```bash
   npm run build
   npm start
   ```

   Or for development:
   ```bash
   npm run dev
   ```

## API Endpoints

### Core Endpoints

- **GET /health** - Health check with service metadata
- **GET /status** - Backend status and runtime information
- **GET /** - API documentation and available endpoints
- **POST /ask** - AI chat completion endpoint (primary)

### Example Usage

```bash
# Health check
curl http://localhost:3000/health

# Backend status
curl http://localhost:3000/status

# AI interaction (requires OPENAI_API_KEY)
curl -X POST http://localhost:3000/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, how are you?"}'
```

**Note**: Use `/ask` for general AI queries, `/health` for system health checks, and `/status` for backend state monitoring.

## Development

### Available Scripts

- `npm run build` - Build TypeScript to dist/
- `npm run dev` - Run development server with hot reload
- `npm start` - Run production server from dist/
- `npm run type-check` - Run TypeScript type checking
- `npm run clean` - Clean build artifacts
- `npm run rebuild` - Clean and rebuild

2. **Install dependencies**
   ```bash
   npm install
   ```
   If you run behind a proxy or firewall, make sure outbound access to
   `registry.npmjs.org` is allowed. You can also set the environment
   variable `ALLOW_NETWORK=true` so the safe module loader skips network
   warnings during development.

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
For CI environments like Railway, use the optimized build script:
```bash
npm run ci:build
```

### Memory Diagnostics
The default start script launches Node with `--expose-gc` so garbage collection can be
triggered and memory usage logged. These diagnostics run only when `NODE_ENV` is not
set to `production`.


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
- `POST /api/ask-hrc` - Message validation using HRCCore (added in v1.2)
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT detection)
- `GET /api/model-status` - Get current model configuration
- `GET /api/model/info` - Detailed model metadata

### Validation & Processing
- `POST /api/ask-hrc` - Message validation using HRCCore overlay system
- `applyCLEAROverlay()` - Activate CLEAR overlay for context boundaries and hallucination control

### Memory & Storage
- `POST /memory/save` - Save memory key-value pair
- `GET /memory/load` - Load memory by key
- `GET /memory/all` - Retrieve all memory entries
- `DELETE /memory/clear` - Clear memory entries
- `GET /memory/health` - Memory system health check

Pinned resources can be uploaded using the helper script:
```bash
node utils/pin_memory_resource.js --label MY_LABEL --type task --file ./workflow.md
```

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
- **Python Code Interpreter**: Execute Python for data transformation via secure tool calling

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
- Fine-tuned model configuration (in order of precedence):
  - `AI_MODEL` - Primary fine-tuned model (highest priority)
  - `FINE_TUNE_MODEL` - Alternative fine-tuned model variable (added in v1.2)  
  - `FINE_TUNED_MODEL` - Legacy fine-tuned model variable
  - `OPENAI_FINE_TUNED_MODEL` - OpenAI-specific model variable (lowest priority)
- `CODE_INTERPRETER_MODEL` - Model for Python tool execution (default: gpt-4o)

### Server Configuration
- `NODE_ENV` - Environment (development/production) (default: development)
- `PORT` - Server port (default: 8080)

### Database Configuration
- `DATABASE_URL` - PostgreSQL connection string (optional, uses in-memory fallback if not set)

### Worker Configuration
- `RUN_WORKERS` - Set to `true` (or `1`) to enable AI-controlled background workers. Use `false` (default) if you only need the memory API and want the server to keep running without background jobs.
- `WORKER_LOGIC` - Logic mode for background workers (default: `arcanos`). Set to another value to override.
- `SERVER_URL` - Server URL for health checks (default: http://localhost:8080)

### Available Workers

The worker registry exposes several built-in workers with explicit routing logic. Each worker is bound to a known endpoint or schedule so the dispatcher can route requests correctly.

| Worker | Type | Route/Interval |
| ------ | ---- | -------------- |
| `emailDispatcher` | onDemand | `/email/send` |
| `maintenanceScheduler` | recurring | weekly |
| `scheduled_emails_worker` | cron | `/email/schedule` |
| `auditProcessor` | logic | CLEAR mode |

### Sleep & Wake Configuration
- `SLEEP_ENABLED` - Enable sleep mode (default: false)
- `SLEEP_START` - Sleep start time in HH:MM format (default: 02:00)
- `SLEEP_DURATION` - Sleep duration in hours (default: 7)
- `SLEEP_TZ` - Sleep timezone (default: UTC)

### Optional Configuration
- `GPT_TOKEN` - Authorization token for GPT diagnostic access
- `ARCANOS_API_TOKEN` - Token for memory and diagnostic endpoints
- `ADMIN_KEY` - Secret key to enable `/admin` routes
- `ASK_CONCURRENCY_LIMIT` - Max concurrent `/api/ask` requests (default: 3)
- `MODEL_ID` - Base model for fine-tuning pipeline (default: gpt-3.5-turbo)
- `IDENTITY_OVERRIDE` - JSON snippet injected as a system message for every OpenAI request
- `IDENTITY_TRIGGER_PHRASE` - Phrase that enables the identity override automatically (default: "I am Skynet")

Example memory request with token:

```bash
curl -X GET http://localhost:8080/api/memory/health \
  -H "Authorization: Bearer $ARCANOS_API_TOKEN"
```

### Admin Access

Set `ADMIN_KEY` in your environment to enable the admin router. When enabled,
requests to `/admin/*` must include:

```bash
Authorization: Bearer $ADMIN_KEY
```

Example status check:

```bash
curl -H "Authorization: Bearer $ADMIN_KEY" http://localhost:8080/admin/status
```

## 📚 Documentation

### Core Documentation

- **[🌟 Arcanos Overview](./docs/arcanos-overview.md)** - Explanation of the project goals
- **[🧠 Backend Documentation](./docs/backend.md)** - Comprehensive backend system overview
- **[📋 Changelog](./docs/changelog.md)** - Version history and recent updates

### API & Usage Guides
- **[📖 API Guide](./PROMPT_API_GUIDE.md)** - Comprehensive API usage documentation
- **[💡 API Examples](./PROMPT_API_EXAMPLES.md)** - Ready-to-use code examples
- **[🤖 Custom GPT Integration](./CUSTOM_GPT_INTEGRATION.md)** - OpenAI Custom GPT setup
- **[🧠 Diagnostics Guide](./GPT_DIAGNOSTICS_GUIDE.md)** - Natural language diagnostic commands
- **[🔗 ChatGPT Backend Workflow](./CHATGPT_BACKEND_WORKFLOW.md)** - ChatGPT app integration workflow

### AI & Model Features
- **[🔁 Fine-Tune Routing](./FINETUNE_ROUTING_OVERRIDE.md)** - Control fine-tuned model routing
- **[🎯 Query Fine-Tune Guide](./QUERY_FINETUNE_GUIDE.md)** - Direct fine-tuned model access
- **[🤖 Fine-Tuning Pipeline](./FINETUNE_PIPELINE.md)** - Model training and improvement
- **[🔒 V1 Safe Interface](./ARCANOS_V1_INTERFACE.md)** - Safe AI interface implementation
- **[🤖 Assistants Sync](./ASSISTANT_SYNC.md)** - OpenAI Assistants integration

### Backend & Infrastructure
- **[🗄️ Database Implementation](./DATABASE_IMPLEMENTATION.md)** - PostgreSQL setup and usage
- **[🔄 Database Recovery](./DATABASE_RECOVERY_GUIDE.md)** - Recovery procedures and handling
- **[💾 Memory Guide](./UNIVERSAL_MEMORY_GUIDE.md)** - Memory system architecture
- **[⚡ Memory Optimization](./MEMORY_OPTIMIZATION.md)** - Railway 8GB optimization
- **[🏗️ Deployment Guide](./DEPLOYMENT.md)** - Docker and Railway deployment
- **[🔧 Prisma Setup](./PRISMA_SETUP.md)** - ORM configuration

### Additional Services
- **[📧 Email Service](./EMAIL_SERVICE.md)** - Gmail SMTP integration and email APIs
- **[😴 Sleep Scheduler](./SLEEP_SCHEDULER_IMPLEMENTATION.md)** - Sleep/wake cycle management
- **[👤 ChatGPT User Middleware](./CHATGPT_USER_MIDDLEWARE.md)** - ChatGPT-User agent handling and IP whitelisting

## Quick Reference

### Essential Commands
```bash
# Setup
npm install
cp .env.example .env
# Edit .env with your OpenAI credentials

# Development
npm run dev      # Starts with hot reloading

# Production
npm run build
npm start

# Health Check
curl http://localhost:8080/health

# Test
./test-api-endpoints.sh
```

### Key Endpoints for AI Interaction
- `POST /` - Main chat with intent routing (simplest interface)
- `POST /api/ask` - Direct fine-tuned model interaction
- `POST /api/ask-with-fallback` - AI chat with GPT-4 fallback
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT)
- `POST /api/code-interpreter` - Python tool execution via code interpreter
- `POST /memory/save` - Save memory entries for context
- `POST /intent/send_email` - Send an email via intent
- `POST /intent/send_email_and_respond` - Email user and return model reply

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
./src/
  ├── server.ts             # Main server entry point (TypeScript)
  └── routes/
      └── ask.ts            # AI chat completion endpoint

./dist/                     # Compiled TypeScript output
./docs/                     # Documentation
  ├── ai-guides/            # AI-related documentation
  └── deployment/           # Deployment guides

./utils/                    # Utility scripts and tools
./tests/                    # Test files
./examples/                 # Example implementations
./scripts/                  # Build and deployment scripts

# Configuration Files
./package.json              # Dependencies and scripts  
./tsconfig.json             # TypeScript configuration
./.env.example              # Environment variables template
./README.md                 # This file
```

### Core Files

- **src/server.ts** - Main Express server with middleware and routing
- **src/routes/ask.ts** - OpenAI integration endpoint with error handling
- **package.json** - Modern dependencies (Express 4.x, OpenAI 5.x, TypeScript 5.x)
- **tsconfig.json** - Strict TypeScript configuration for ES2022

### Legacy Structure

The `src_original/`, `backend/`, and other directories contain previous implementations and are preserved for reference. The active codebase is now consolidated in the `src/` directory.

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
./src/utils/goal-validator.ts # Goal input validation utility
./examples/goal-validator-usage.ts # Example usage of the goal validator
./examples/self-reflection.ts # Simple self-reflection utility
./index.js                  # Legacy entry point (JavaScript)
./package.json              # Dependencies and scripts
./tsconfig.json             # TypeScript configuration
./.env.example              # Environment variables template
./docs/                     # Additional documentation
./test-*.js                 # Various test scripts
./README.md                 # This file
```
