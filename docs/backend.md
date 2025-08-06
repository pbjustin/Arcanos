# 🧠 Arcanos Backend Documentation

## 🌐 Environment Configuration

### Current Environment Variables

| Variable | Value | Description |
|----------|--------|-------------|
| `NODE_ENV` | `production` | Environment mode (production/development) |
| `PORT` | `8080` | Server port (Railway auto-assigns) |
| `OPENAI_API_KEY` | `[REQUIRED]` | OpenAI API authentication key |
| `FINE_TUNED_MODEL` | `ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH` | Primary fine-tuned model ID (supports multiple variable names) |
| `RUN_WORKERS` | `true` | Enable AI-controlled CRON worker processes |
| `WORKER_LOGIC` | `arcanos` | Default logic mode for background workers |
| `SERVER_URL` | `https://arcanos-v2-production.up.railway.app` | Production server URL for health checks |
| `DATABASE_URL` | `[OPTIONAL]` | PostgreSQL connection string (fallback to in-memory if not set) |
| `ADMIN_KEY` | `[OPTIONAL]` | Enable admin router and protect `/admin/*` routes |

### Deprecated Variables (Removed)
- ❌ `PORT=3000` - Now defaults to `8080` and auto-assigned by Railway
- ❌ `OPENAI_FINE_TUNED_MODEL` - Consolidated to `FINE_TUNED_MODEL`
- ❌ `SESSION_SECRET` - No longer required for current implementation

## 🔁 AI-Controlled CRON Worker Schedules

The CRON worker system runs when `RUN_WORKERS=true` and implements **AI-controlled execution** where the fine-tuned model decides when to execute scheduled tasks.

### Active Schedules (AI-Controlled)

| Task | Schedule | Approval System | Description |
|------|----------|-----------------|-------------|
| 🔄 **Health Check** | `*/15 * * * *` (every 15 minutes) | AI Model Approval | Tests fine-tuned model responsiveness and system health |
| 🧹 **Maintenance** | `0 */6 * * *` (every 6 hours) | AI Model Approval | Performs cleanup tasks and cache management |
| 💾 **Memory Sync** | `0 */4 * * *` (every 4 hours) | AI Model Approval | Syncs persistent memory state to disk storage |
| 🎯 **Goal Watcher** | `*/30 * * * *` (every 30 minutes) | AI Model Approval | Monitors system goals and triggers execution |
| 🤖 **Assistant Sync** | `15,45 * * * *` (at :15 and :45) | AI Model Approval | Syncs OpenAI Assistants to `config/assistants.json` |

### AI Control System
- **All CRON tasks require AI approval** before execution via `modelControlHooks`
- **JSON instruction templates** define task parameters and priorities
- **AI dispatcher** makes operational decisions for each scheduled task
- Workers only execute when the fine-tuned model explicitly approves
- Comprehensive logging for all AI decisions and worker executions

## 🤖 Fine-Tuned Model Configuration & Behavior

-### Active Model
- **Primary Model**: `ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH`
- **Model Type**: Fine-tuned GPT-3.5 Turbo
- **Version**: `arcanos-v2`
- **Owner**: Personal account
- **Training Date**: November 2024

### Model Behavior & Capabilities
- **AI System Control**: Model has operational control over CRON workers and system tasks
- **Intent Detection**: Automatic routing for WRITE/AUDIT tasks via intent analysis
- **Permission-Based Fallback**: Model must explicitly approve fallback to standard GPT models
- **Context Awareness**: Maintains session and memory context across interactions
- **Specialized Routing**: Handles creative writing, audit tasks, and general processing

### OpenAI Integration
- ✅ **Fine-tuned model**: Primary model for all requests
- 🔒 **Fallback control**: Requires explicit permission before using standard GPT models
- 📊 **Error handling**: Comprehensive logging and graceful degradation
- 🎛️ **Model hooks**: AI controls system operations via `modelControlHooks`

## 🤖 OpenAI Assistants Integration

### Assistant Sync Service
- **Automatic sync** of all OpenAI Assistants from organization
- **Schedule**: Every 30 minutes (at :15 and :45 minutes past the hour)
- **Storage**: Saves to `config/assistants.json` for runtime lookup
- **Name normalization**: Converts names to `UPPERCASE_WITH_UNDERSCORES` format

### Current Integrated Assistants
- Assistant data is automatically synchronized and available for runtime lookup
- Each assistant includes: ID, name, instructions, tools, and model configuration
- Assistants can be invoked through the API using their normalized names

### Configuration File Format
```json
{
  "ARCANOS_RUNTIME_COMPANION": {
    "id": "asst_abc123",
    "name": "Arcanos Runtime Companion", 
    "instructions": "System instructions...",
    "tools": [...],
    "model": "gpt-4"
  }
}
```

### API Endpoints

#### Core Endpoints
- `GET /health` - Health check endpoint
- `GET /` - API status message  
- `POST /` - Main chat endpoint with intent-based routing
- `POST /ask` - Simple query processing endpoint
- `POST /webhook` - GitHub webhook integration

#### AI Chat Endpoints
- `GET /api` - Welcome message with model status
- `POST /api/echo` - Echo endpoint for testing
- `POST /api/ask` - Fine-tuned model chat (no fallback)
- `POST /api/ask-with-fallback` - Chat with GPT fallback permission
- `POST /api/ask-v1-safe` - Safe interface with RAG/HRC features
- `POST /api/arcanos` - Intent-based routing (WRITE/AUDIT detection)
- `GET /api/model-status` - Get current model configuration
- `GET /api/model/info` - Detailed model metadata

#### Validation & Processing
- `POST /api/ask-hrc` - Message validation using HRCCore overlay system with resilience and fidelity scoring

### Admin Router
- Enabled when `ADMIN_KEY` is set in the environment
- All admin requests require `Authorization: Bearer <ADMIN_KEY>`
- `GET /admin/status` - Simple health status

### Memory & Storage System

#### Core Memory Operations
- `POST /api/memory` - Store a memory entry with automatic key generation
- `GET /api/memory` - Retrieve all memory entries for current context
- `POST /memory/save` - Save memory key-value pair with explicit key
- `GET /memory/load` - Load memory by specific key
- `GET /memory/all` - Retrieve all memory entries (admin)
- `DELETE /memory/clear` - Clear memory entries
- `GET /memory/health` - Memory system health check

#### Memory Architecture
- **PostgreSQL Backend**: Primary storage with automatic schema management
- **In-Memory Fallback**: Graceful degradation when database unavailable
- **Session Tracking**: User and session-based context preservation
- **Metadata Support**: Tags, timestamps, and custom metadata for entries
- **Health Monitoring**: Continuous health checks and connection validation

### Current Memory Snapshot Routines
- **Automatic snapshots** every 4 hours via AI-controlled memory sync worker
- **Real-time persistence** for all memory operations
- **Session isolation** with user-specific memory spaces
- **Backup routines** integrated with maintenance worker cycles
- **Recovery procedures** with automatic database reconnection

#### Canon Management
- `GET /api/canon/files` - List all canon storyline files
- `GET /api/canon/files/:filename` - Read specific canon file
- `POST /api/canon/files/:filename` - Write/update canon file

#### Container Management
- `GET /api/containers/status` - List Docker container status
- `POST /api/containers/:name/:action` - Control containers (start/stop/restart)

## 🔧 API Health Check Process

### Core Health Endpoints
- `GET /health` - Primary health check endpoint (returns `✅ OK`)
- `GET /api/memory/health` - Memory system health validation
- `GET /api/model-status` - Current fine-tuned model configuration
- `GET /api/model/info` - Detailed model metadata and status
- `GET /system/diagnostics` - Comprehensive system diagnostics
- `GET /sync/diagnostics` - GPT-accessible system metrics

### Automated Health Monitoring
- **CRON health checks** every 15 minutes via AI-controlled system
- **Railway health monitoring** with automatic restarts on failure
- **Memory system validation** with connection pool monitoring
- **Model responsiveness tests** to ensure fine-tuned model availability
- **Container status monitoring** for Docker-based services

### Health Check Response Format
```json
{
  "status": "healthy",
  "timestamp": "2024-07-20T12:00:00Z",
  "components": {
    "server": "online",
    "database": "connected",
    "memory": "operational", 
    "model": "responsive",
    "workers": "active"
  },
  "uptime": "24h 15m",
  "version": "1.0.0"
}
```

## 🛠 Maintenance Protocols

### AI-Controlled Maintenance System
- **Schedule**: Every 6 hours (`0 */6 * * *`)
- **Approval**: Requires fine-tuned model approval before execution
- **Scope**: Cache management, temporary file cleanup, memory optimization
- **Logging**: Comprehensive logs for all maintenance activities

### Maintenance Tasks
1. **Cache Cleanup**: Clear temporary files and expired cache entries
2. **Memory Optimization**: Garbage collection and memory pool management  
3. **Log Rotation**: Archive old logs and maintain storage limits
4. **Connection Pool Management**: Reset stale database connections
5. **Health Validation**: Full system health check after maintenance

### Sleep & Wake Cycle Configuration
- **Sleep Detection**: Configurable sleep window support
- **Sleep Start**: Default 02:00 UTC (configurable via `SLEEP_START`)
- **Sleep Duration**: Default 7 hours (configurable via `SLEEP_DURATION`)
- **Wake Operations**: Automatic health checks and system validation on wake
- **Low Power Mode**: Reduced background activity during sleep hours

## 🌐 Server Lifecycle

### Auto-Sleep Logic
- **Sleep Configuration**: Configurable via environment variables
  - `SLEEP_ENABLED=true` - Enable/disable sleep mode
  - `SLEEP_START=02:00` - Sleep start time (default: 02:00 UTC)
  - `SLEEP_DURATION=7` - Sleep duration in hours (default: 7 hours)
  - `SLEEP_TZ=UTC` - Timezone for sleep scheduling
- **Sleep Behavior**: Reduced background activity during configured sleep hours
- **Wake Operations**: Full system validation and health checks on wake
- **Monitoring**: Continuous basic health checks maintain uptime even during sleep

### Current Sleep Routines
- **Sleep Window Detection**: Automatic detection of configured sleep periods
- **Graceful Transition**: Smooth transition to low-power monitoring mode
- **Wake Validation**: Comprehensive system checks when exiting sleep mode
- **Activity Reduction**: Limited background worker activity during sleep
- **Emergency Override**: Critical alerts can override sleep mode when necessary

### Graceful Shutdown
```javascript
// SIGTERM Handling
process.on("SIGTERM", () => {
  console.log("[SIGNAL] SIGTERM received. Gracefully shutting down...");
  server.close(() => {
    console.log('✅ Server closed successfully');
    process.exit(0);
  });
});
```

### Production Monitoring
- **Public URL**: [`https://arcanos-v2-production.up.railway.app`](https://arcanos-v2-production.up.railway.app)
- **Health Endpoint**: `GET /health` returns `✅ OK`
- **Uptime Monitoring**: Railway health checks every 5 minutes
- **Restart Policy**: `ON_FAILURE` with max 10 retries

## 🏗️ Deployment Configuration

### Railway Settings
```json
{
  "deploy": {
    "startCommand": "node dist/index.js",
    "healthcheckPath": "/health",
    "healthcheckTimeout": 300,
    "restartPolicyType": "ON_FAILURE",
    "restartPolicyMaxRetries": 10
  }
}
```

### Build Process
- **Builder**: NIXPACKS
- **Build Command**: `npm ci && npm run build`
- **Start Command**: `node dist/index.js`
- **TypeScript**: Compiled to `dist/` directory

### Entry Points
- **Primary**: `src/index.ts` → `dist/index.js`
- **Worker Init**: `src/worker-init.ts` → `dist/worker-init.js`

## 🔧 Technical Architecture

### Core Services
- **Express Server**: Main HTTP server with middleware
- **OpenAI Service**: Fine-tuned model integration with fallback handling
- **CRON Worker**: Background task scheduling and monitoring
- **Storage System**: Memory persistence and session management

### Error Handling
- **Uncaught Exceptions**: Logged and monitored
- **Unhandled Rejections**: Tracked for debugging
- **API Errors**: Graceful degradation with user feedback
- **Model Failures**: Explicit permission required for fallback

### Security Features
- **Environment Isolation**: Production vs development configurations
- **API Key Protection**: Secure handling of OpenAI credentials
- **Fallback Controls**: Permission-based model fallback system
- **Process Monitoring**: Signal handling and graceful shutdown

## 📊 Monitoring & Logging

### Log Categories
- `[SERVER]` - Server startup and configuration
- `[SIGNAL]` - Process signal handling
- `[CRON]` - Worker schedule execution
- `[HEALTH]` - Health check results
- `[PROBE]` - Model responsiveness tests
- `[MAINTENANCE]` - Cleanup operations
- `[MEMORY]` - Persistence operations

### Production Monitoring
- **Railway Metrics**: Automated service monitoring
- **Health Checks**: Continuous availability verification
- **Error Tracking**: Comprehensive error logging
- **Performance**: Request/response timing and status codes

---

*Documentation last updated: Backend docs refresh (v1.1) - Current as of latest deployment*