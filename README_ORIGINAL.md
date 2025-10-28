# Arcanos Backend

An AI-controlled TypeScript backend featuring fine-tuned OpenAI model integration, intelligent routing, and persistent memory storage. Arcanos provides a comprehensive HTTP API that is orchestrated entirely by an AI model with advanced worker scheduling and memory management.

## 🧠 Core Features

- **AI-Managed Operations**: Fine-tuned GPT model (`ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH`) controls all system operations
- **Intelligent Memory System**: PostgreSQL backend with in-memory fallback and dual-mode conversation storage
- **OpenAI SDK v5.16.0**: Modern integration with streaming, function calling, assistants, and GPT-5 support
- **Image Generation**: DALL·E support via OpenAI's Images API with AI-refined prompts
- **Notion Database Sync**: Fetch WWE Universe roster data via the official Notion SDK
- **Worker System**: AI-controlled CRON scheduling for maintenance, health checks, and background tasks
- **HRC Integration**: Hallucination-Resistant Core with reliability scoring
- **TypeScript Architecture**: Modern, type-safe Express.js backend with comprehensive error handling
- **Railway Optimized**: Cloud deployment ready with health monitoring and graceful shutdown

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm 8+
- PostgreSQL (optional - uses in-memory fallback)

## 🛡️ What “Environment Safety” Means for You

If you're just trying to get ARCANOS running, the new environment safety layer keeps an eye on the surroundings for you. On
startup we double-check that ARCANOS is on a machine we recognize, run a tiny rehearsal in a sandbox, and switch into a cautious
"safe mode" if anything looks off. The startup log and `/health` check now spell out whether everything is trusted or whether we're
being extra careful. Want the full plain-language breakdown? [Read the overview](docs/environment-security-overview.md).

### Installation
```bash
git clone <repository-url>
cd Arcanos
npm install
cp .env.example .env
# Edit .env with your OpenAI API key
npm run build
npm start
```

### Test the Installation
```bash
curl http://localhost:8080/health
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, how are you?"}'

# Generate an image (prompt is refined by the fine-tuned model)
curl -X POST http://localhost:8080/image \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A sunset over the mountains"}'

# Fetch WWE Universe roster from Notion
curl http://localhost:8080/booker/roster
```

## ⚙️ Configuration

### Required Environment Variables
```bash
OPENAI_API_KEY=your-openai-api-key-here
AI_MODEL=your-fine-tuned-model-id-here  # Default: ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH
```

### Optional Database Configuration
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/arcanos  # Optional - uses in-memory if not set
```

### Server Configuration
```bash
NODE_ENV=development           # Environment mode (development/production)
PORT=8080                      # Server port
ARC_LOG_PATH=/tmp/arc/log      # Directory for ARCANOS log files
ARC_MEMORY_PATH=/tmp/arc/memory # Directory for ARCANOS memory files
```

### Worker System
```bash
RUN_WORKERS=true               # Enable AI-controlled background workers
WORKER_COUNT=4                 # Number of worker processes
WORKER_MODEL=your-model-id     # Worker-specific model (defaults to AI_MODEL)
WORKER_API_TIMEOUT_MS=60000    # Worker API timeout in milliseconds
```

### OpenAI Advanced Features
```bash
GPT5_MODEL=gpt-5              # GPT-5 model configuration
BOOKER_TOKEN_LIMIT=512        # Token limit for backstage booking prompts
TUTOR_DEFAULT_TOKEN_LIMIT=200 # Default token limit for tutor queries
```

### Notion Integration (Optional)
```bash
NOTION_API_KEY=your-notion-api-key-here
WWE_DATABASE_ID=your-notion-wwe-database-id
```

### Railway Deployment
```bash
RAILWAY_PROJECT=arcanos-core
RAILWAY_ENVIRONMENT=production
API_URL=https://your-app.railway.app
```

### GitHub Integration (Optional)
```bash
GITHUB_TOKEN=your-github-token-here
GITHUB_WEBHOOK_SECRET=your-webhook-secret-here
ENABLE_GITHUB_ACTIONS=true
```

### Email Services (Optional)
```bash
EMAIL_SERVICE=smtp             # Choose: smtp, gmail, mailtrap, ethereal
EMAIL_HOST=smtp.sendgrid.net
EMAIL_USER=apikey
EMAIL_PASS=your-smtp-password-or-api-key
EMAIL_FROM_NAME=Arcanos Backend
```

### Security & Admin
```bash
ADMIN_KEY=your-admin-key-here
ALLOW_ROOT_OVERRIDE=true
ROOT_OVERRIDE_TOKEN=supersecrettoken
```

## 🔧 Current Architecture

### AI Control System
- **Fine-tuned Model**: Configured via `AI_MODEL` environment variable
- **AI-Controlled CRON**: Health checks every 15min, maintenance every 6hrs, memory sync every 4hrs
- **Intelligent Routing**: AI determines request processing strategy
- **Permission System**: AI approval required for sensitive operations

### Memory & Persistence
- **Primary Storage**: PostgreSQL with automatic schema management
- **Fallback Mode**: In-memory storage when database unavailable  
- **Memory Types**: Context, facts, preferences, decisions, patterns

## 🧹 Recent Optimizations

This repository has been optimized for **OpenAI SDK + Railway deployment**:

### Removed Bloat
- Deleted unused validation/purification scripts (`dead_code_scanner.py`, `demo-purification.cjs`)
- Removed redundant documentation files (`PURIFICATION_README.md`, `REFactorING.md`)
- Eliminated duplicate OpenAI client implementations
- Cleaned up broken purification routes and services

### Updated Dependencies
- OpenAI SDK v5.16.0 (latest stable)
- ESLint v9 (from deprecated v8)
- Updated TypeScript ESLint plugins for compatibility
- Removed deprecated dependencies

### Environment Variables
- Removed hardcoded fine-tuned model IDs from all source files
- Consolidated duplicate environment variables
- Updated `.env.example` with generic placeholders
- Centralized model configuration through `getDefaultModel()`

### Code Quality
- Simplified complex routing logic
- Fixed TypeScript null safety issues
- Removed unnecessary complexity in fallback handlers
- Standardized error handling patterns
- **Session Isolation**: User and session-based context preservation

### Worker System
- **Dynamic Loading**: Workers loaded from filesystem at startup
- **AI Scheduling**: CRON jobs managed by AI model decisions
- **Context Management**: Shared worker context with logging and error handling
- **Health Monitoring**: Automatic worker status reporting

## 🌐 API Endpoints

### Core AI Endpoints
```bash
GET  /health           # System health check
GET  /                 # API status and information
POST /ask              # Primary AI chat endpoint (no confirmation required)
POST /brain            # Advanced AI processing (requires confirmation)
POST /arcanos          # Main AI interface with intent routing (requires confirmation)
POST /arcanos-query    # Direct query to Arcanos AI model
```

### AI Processing & Tools
```bash
POST /write            # AI writing assistance (requires confirmation)
POST /guide            # AI-generated guides (requires confirmation)
POST /audit            # Code audit functionality (requires confirmation)  
POST /sim              # Simulation endpoints (requires confirmation)
POST /image            # DALL·E image generation
POST /api/ask-hrc      # Hallucination-Resistant Core queries
```

### Memory Management
```bash
GET  /memory/health    # Memory system status
POST /memory/save      # Store memory entries (requires confirmation)
GET  /memory/load      # Retrieve memory value by key
DELETE /memory/delete  # Remove memory entries (requires confirmation)
GET  /memory/list      # List all memory keys and values
GET  /memory/view      # View memory system overview

# Dual-mode conversation storage
POST /memory/dual/save # Store conversation + metadata (via API)
GET  /memory/dual/:sessionId      # Retrieve conversation messages
GET  /memory/dual/:sessionId/meta # Retrieve session metadata
POST /memory/resolve   # Session memory resolution
```

### System Control & Monitoring
```bash
GET  /status           # Backend state information
POST /heartbeat        # System heartbeat (requires confirmation)
GET  /workers/status   # Worker system status and health
POST /workers/run/*    # Execute specific workers (requires confirmation)
```

### RAG & Research
```bash
POST /rag/fetch        # Fetch content for RAG processing
POST /rag/query        # Query against fetched content
```

### Orchestration & Admin  
```bash
GET  /orchestration/status  # GPT-5 orchestration shell status
POST /orchestration/reset   # Reset orchestration state (requires confirmation)
POST /orchestration/purge   # Purge orchestration data (requires confirmation)
```

### Development & Testing
```bash
GET  /api/test         # Basic health test endpoint
POST /siri             # Siri integration endpoint (requires confirmation)
POST /modules/<module> # Module dispatcher (tutor, gaming, etc.)
POST /queryroute       # Dynamic module routing

### Example Usage
```bash
# Simple AI query
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum computing"}'

# Memory storage (requires confirmation)
curl -X POST http://localhost:8080/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key": "preference", "value": "dark_mode", "includeMeta": true}'

# Health check
curl http://localhost:8080/health
```

## 🛡️ Security & Compliance

### Confirmation Requirements
Most sensitive operations require explicit user confirmation via the `x-confirmed: yes` header to ensure compliance with OpenAI's Terms of Service and prevent unauthorized actions.

If you're routing traffic through Custom GPTs that you personally supervise, populate the `TRUSTED_GPT_IDS` environment variable with a comma-separated list of approved GPT IDs. When a request supplies a matching `x-gpt-id` header (or `gptId` in the payload), the confirmation gate recognizes the human review already performed in the GPT interface and allows the request without the manual confirmation header.

**Protected Endpoints** (require confirmation):
- Data modification operations (`/memory/save`, `/memory/delete`)
- AI processing with side effects (`/arcanos`, `/brain`, `/write`, `/guide`, `/audit`, `/sim`)
- Worker execution (`/workers/run/*`, `/sdk/*`)  
- System control (`/orchestration/*`, `/heartbeat`)
- Administrative functions (`/siri`, `/backstage/*`)

**Safe Endpoints** (no confirmation needed):
- Read operations (`/health`, `/status`, `/memory/load`, `/memory/list`)
- Primary AI endpoint (`/ask`)
- Diagnostic endpoints (`/memory/health`, `/workers/status`, `/orchestration/status`)
- Test endpoints (`/api/test`, `/api/fallback/test`)

### Example Usage with Confirmation
```bash
# Protected operation - requires confirmation header
curl -X POST http://localhost:8080/memory/save \
  -H "Content-Type: application/json" \
  -H "x-confirmed: yes" \
  -d '{"key": "preference", "value": "dark_mode"}'

# Safe operation - no confirmation needed
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Explain quantum computing"}'
```

## 🚄 Railway Deployment

Arcanos is optimized for deployment on Railway with automatic builds and health monitoring.

### Quick Deploy to Railway

1. **Fork this repository** to your GitHub account

2. **Connect to Railway**:
   - Go to [Railway.app](https://railway.app)
   - Click "Deploy from GitHub repo"
   - Select your forked repository

3. **Configure Environment Variables**:
   ```bash
   OPENAI_API_KEY=your-openai-api-key-here
   NODE_ENV=production
   PORT=8080
   AI_MODEL=ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH
   ```

4. **Optional Environment Variables**:
   ```bash
   DATABASE_URL=postgresql://user:pass@host:port/db  # Railway PostgreSQL
   RUN_WORKERS=true
   NOTION_API_KEY=your-notion-key                    # For WWE roster sync
   WWE_DATABASE_ID=your-notion-database-id
   ```

### Railway Configuration Features

- ✅ **Automatic Port Binding**: Uses Railway's `PORT` environment variable
- ✅ **Health Monitoring**: `/health` endpoint for Railway health checks  
- ✅ **Graceful Shutdown**: Proper SIGTERM/SIGINT handling
- ✅ **Environment Detection**: Automatically detects Railway platform
- ✅ **Build Optimization**: TypeScript compilation with dependency caching
- ✅ **Log Aggregation**: Structured logging compatible with Railway logs

### Monitoring & Debugging

Railway health checks use the `/health` endpoint:
```bash
curl https://your-app.railway.app/health
```

Monitor logs through Railway dashboard or CLI:
```bash
railway logs --tail
```

### Production Considerations

- Set `NODE_ENV=production` for optimal performance
- Configure `DATABASE_URL` for persistent storage (Railway PostgreSQL recommended)
- OpenAI API key is required - mock responses are used in development only
- Workers are disabled by default on Railway - enable with `RUN_WORKERS=true`

## 🔧 Development

### Available Scripts
```bash
npm run dev          # Development server with hot reload
npm run build        # Build TypeScript to dist/
npm start           # Run production server
npm run type-check  # TypeScript type checking
npm test            # Run test suite
npm run guide:generate -- <entry_key>  # Generate a tagged build guide
```

### Project Structure
```
src/
├── server.ts           # Main server entry point
├── app.ts              # Express application configuration
├── startup.ts          # Application startup routines
├── config/            # Configuration management
│   ├── index.ts       # Main configuration
│   └── workerConfig.ts # Worker system configuration
├── routes/            # API route handlers
│   ├── register.ts    # Route registration
│   ├── ask.ts         # Primary AI endpoints
│   ├── arcanos.ts     # Main AI interface
│   ├── memory.ts      # Memory management
│   ├── workers.ts     # Worker system control
│   ├── orchestration.ts # GPT-5 orchestration
│   ├── image.ts       # Image generation
│   ├── hrc.ts         # Hallucination-Resistant Core
│   └── ...           # Additional specialized routes
├── services/          # Core business logic
│   ├── openai.ts      # OpenAI SDK integration
│   ├── memoryAware.ts # Memory-aware AI processing
│   ├── persistenceManager.ts # Data persistence
│   ├── orchestrationInit.ts  # GPT-5 orchestration
│   └── ...           # Additional services
├── logic/             # AI reasoning and processing
│   ├── arcanos.ts     # Core AI logic
│   ├── aiCron.ts      # AI-controlled scheduling
│   └── trinity.ts     # Advanced AI reasoning
├── memory/            # Memory system
│   └── store.ts       # In-memory storage implementation
├── utils/             # Utility functions
│   ├── workerBoot.ts  # Worker system initialization
│   ├── structuredLogging.ts # Logging system
│   └── ...           # Additional utilities
├── types/             # TypeScript type definitions
└── middleware/        # Express middleware
    ├── confirmGate.ts # Confirmation requirement middleware
    ├── fallbackHandler.ts # Fallback response handling
    └── validation.ts  # Request validation

docs/                  # Documentation
├── ai-guides/         # AI-specific documentation (50+ guides)
├── CHANGELOG.md       # Version history
└── deployment/        # Deployment guides

tests/                 # Test suite
├── openai-integration.test.ts
├── session-memory-roundtrip.test.ts
├── worker-task-queue.test.ts
└── ...               # Additional test files
```

### Worker Development
Workers are automatically loaded from the filesystem and scheduled by the AI system:

```typescript
// Example worker structure
export default {
  name: 'example-worker',
  schedule: '0 */6 * * *',  // Every 6 hours
  async run(context) {
    await context.log('Worker started');
    // Worker logic here
    await context.log('Worker completed');
  }
};
```

## 🚀 Deployment

### Environment Setup
1. Set required environment variables in your deployment platform
2. Ensure PostgreSQL database is available (or use in-memory fallback)
3. Configure `RUN_WORKERS=true` for full functionality

### Railway Deployment
```bash
# Railway will automatically:
# - Install dependencies
# - Build TypeScript
# - Start the server
# Set environment variables in Railway dashboard
```

### Docker Deployment
```bash
docker build -t arcanos .
docker run -p 8080:8080 -e OPENAI_API_KEY=your-key arcanos
```

### GPT Module Routing

Map custom GPT IDs to backend modules via the `GPT_MODULE_MAP` environment variable. Set it to a JSON object where each key is a GPT ID and the value provides the module route and name:

```bash
GPT_MODULE_MAP='{"gpt-backstage":{"route":"backstage-booker","module":"BACKSTAGE:BOOKER"}}'
```

This enables adding new GPT-to-module connections without requiring code changes.

## 📚 Documentation

### Core Guides
- **[Setup Guide](./docs/ai-guides/SETUP_GUIDE.md)** - Detailed installation instructions
- **[API Reference](./docs/ai-guides/PROMPT_API_GUIDE.md)** - Complete API documentation
- **[Memory System](./docs/ai-guides/UNIVERSAL_MEMORY_GUIDE.md)** - Memory architecture guide

### AI Features
- **[OpenAI Integration](./docs/ai-guides/BACKEND_REFACTOR_SUMMARY.md)** - OpenAI SDK implementation
- **[Assistant Sync](./docs/ai-guides/ASSISTANT_SYNC.md)** - OpenAI Assistants integration
- **[Worker System](./docs/ai-guides/SLEEP_SCHEDULER_IMPLEMENTATION.md)** - AI-controlled workers

### Development
- **[Contributing Guide](./docs/ai-guides/AI_CONTROL_SERVICE.md)** - Development best practices
- **[Database Guide](./docs/ai-guides/DATABASE_IMPLEMENTATION.md)** - Database setup and usage
- **[Deployment Guide](./docs/deployment/DEPLOYMENT.md)** - Production deployment

## 🐍 Python Module

A companion Python package provides strict GPT-5 reasoning with enforced model usage and automatic maintenance alerts.
See [ARCANOS_PYTHON_README.md](./ARCANOS_PYTHON_README.md) for installation, configuration, and testing instructions.

## 🔄 Changelog

See [CHANGELOG.md](./docs/CHANGELOG.md) for detailed version history and recent updates.

## 🤝 Best Practices

### For Developers
1. **Use TypeScript**: Maintain type safety throughout the codebase
2. **Memory-Aware Design**: Consider memory context in all AI interactions
3. **Error Handling**: Implement comprehensive error handling and logging
4. **Worker Patterns**: Follow the established worker context pattern
5. **Configuration**: Use environment variables for all configurable options

### For AI Integration
1. **Confirmation Flow**: Always prompt users before sensitive operations
2. **Memory Context**: Utilize memory system for conversation continuity
3. **Error Recovery**: Implement graceful fallbacks for API failures
4. **Rate Limiting**: Respect OpenAI usage limits and implement backoff
5. **Security**: Validate all inputs and sanitize outputs

## 📝 License

MIT License - See LICENSE file for details.

---

**Arcanos Backend** - AI-controlled server architecture for modern applications.