# 🧠 Arcanos Backend Documentation

## 🌐 Environment Configuration

### Current Environment Variables

| Variable | Value | Description |
|----------|--------|-------------|
| `NODE_ENV` | `production` | Environment mode (production/development) |
| `PORT` | `8080` | Server port (Railway auto-assigns) |
| `OPENAI_API_KEY` | `[REQUIRED]` | OpenAI API authentication key |
| `FINE_TUNED_MODEL` | `ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106` | Primary fine-tuned model ID |
| `RUN_WORKERS` | `true` | Enable CRON worker processes |
| `SERVER_URL` | `https://arcanos-production-426d.up.railway.app` | Production server URL for health checks |

### Deprecated Variables (Removed)
- ❌ `PORT=3000` - Now defaults to `8080` and auto-assigned by Railway
- ❌ `OPENAI_FINE_TUNED_MODEL` - Consolidated to `FINE_TUNED_MODEL`
- ❌ `SESSION_SECRET` - No longer required for current implementation

## 🔁 CRON Worker Schedules

The CRON worker system runs when `RUN_WORKERS=true` and manages the following schedules:

### Active Schedules

| Task | Schedule | Active Hours | Description |
|------|----------|--------------|-------------|
| 🕓 **Sleep Cycle Check** | `* * * * *` (every minute) | 7:00 AM - 2:00 PM | Monitors low-power state during sleep hours |
| 🔄 **Health Check** | `*/5 * * * *` (every 5 minutes) | 24/7 | Pings `/health` endpoint to verify server status |
| 🧹 **Maintenance** | `0 * * * *` (every hour) | 24/7 | Performs cleanup tasks and cache management |
| 🧠 **Model Probe** | `*/15 * * * *` (every 15 minutes) | 24/7 | Tests model responsiveness via `/api/ask` |
| 💾 **Memory Sync** | `*/30 * * * *` (every 30 minutes) | 24/7 | Syncs persistent state to disk |

### Worker Management
- Workers are conditionally started based on `RUN_WORKERS` environment variable
- Health checks target the configured `SERVER_URL`
- All schedules include comprehensive logging for monitoring

## 🤖 Model Configuration & Behavior

### Active Model
- **Primary Model**: `ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106`
- **Model Type**: Fine-tuned GPT-3.5 Turbo
- **Version**: `arcanos-v1-1106`
- **Owner**: Personal account

### OpenAI Integration
- ✅ **Fine-tuned model**: Primary model for all requests
- ❌ **OpenAI fallback**: DISABLED (requires explicit permission)
- 🔒 **Permission system**: Requests permission before using fallback models
- 📊 **Error handling**: Comprehensive logging and graceful degradation

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
- `POST /api/ask-hrc` - Message validation using HRCCore

#### Memory & Storage
- `POST /api/memory` - Store a memory entry
- `GET /api/memory` - Retrieve all memory entries

#### Canon Management
- `GET /api/canon/files` - List all canon storyline files
- `GET /api/canon/files/:filename` - Read specific canon file
- `POST /api/canon/files/:filename` - Write/update canon file

#### Container Management
- `GET /api/containers/status` - List Docker container status
- `POST /api/containers/:name/:action` - Control containers (start/stop/restart)

#### Diagnostics & Monitoring
- `POST /api/diagnostics` - Natural language diagnostic commands
- `GET /api/workers/status` - Background worker status
- `POST /api/worker/dispatch` - Run a specific worker module
- `GET /sync/diagnostics` - GPT-accessible system metrics

### Removed Features
- ❌ **Heartbeat endpoints**: Removed per user request (no longer in use)
- ❌ **Default model fallback**: Must request permission for fallback

## 🌐 Server Lifecycle

### Auto-Sleep Logic
- **Sleep Time**: 7:00 AM (enters low-power monitoring)
- **Wake Time**: 2:00 PM (resumes full operation)
- **Sleep Behavior**: Sleep cycle worker runs every minute during sleep hours
- **Monitoring**: Continuous health checks maintain uptime

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
- **Public URL**: [`https://arcanos-production-426d.up.railway.app`](https://arcanos-production-426d.up.railway.app)
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