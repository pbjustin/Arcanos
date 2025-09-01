# Arcanos Backend

An AI-controlled TypeScript backend featuring fine-tuned OpenAI model integration, intelligent routing, and persistent memory storage. Arcanos provides a conventional HTTP API that is orchestrated entirely by an AI model.

## 🧠 Core Features

- **AI-Managed Operations**: Fine-tuned GPT model controls all system operations
- **Intelligent Memory**: PostgreSQL backend with in-memory fallback for persistence
- **OpenAI SDK v5**: Modern integration with streaming, function calling, and assistants
- **Notion Database Sync**: Fetch Universe Mode data via the official Notion SDK
- **Worker System**: AI-controlled CRON scheduling for maintenance and background tasks
- **TypeScript Architecture**: Modern, type-safe Express.js backend

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm 8+
- PostgreSQL (optional - uses in-memory fallback)

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
```

## ⚙️ Configuration

### Required Environment Variables
```bash
OPENAI_API_KEY=your-openai-api-key-here
NOTION_API_KEY=your-notion-api-key-here
AI_MODEL=ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH  # Default fine-tuned model
DATABASE_URL=postgresql://user:pass@localhost:5432/arcanos  # Optional - uses in-memory if not set
```

### Optional Settings
```bash
PORT=8080                    # Server port
RUN_WORKERS=true            # Enable AI-controlled background workers
NODE_ENV=development        # Environment mode
```

## 🔧 Current Architecture

### AI Control System
- **Fine-tuned Model**: `ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH`
- **AI-Controlled CRON**: Health checks every 15min, maintenance every 6hrs, memory sync every 4hrs
- **Intelligent Routing**: AI determines request processing strategy
- **Permission System**: AI approval required for sensitive operations

### Memory & Persistence
- **Primary Storage**: PostgreSQL with automatic schema management
- **Fallback Mode**: In-memory storage when database unavailable  
- **Memory Types**: Context, facts, preferences, decisions, patterns
- **Session Isolation**: User and session-based context preservation

### Worker System
- **Dynamic Loading**: Workers loaded from filesystem at startup
- **AI Scheduling**: CRON jobs managed by AI model decisions
- **Context Management**: Shared worker context with logging and error handling
- **Health Monitoring**: Automatic worker status reporting

## 🌐 API Endpoints

### Core Endpoints
```bash
GET  /health           # System health check
GET  /                 # API status and information
POST /ask              # Primary AI chat endpoint (no confirmation required)
POST /arcanos          # Main AI interface with intent routing
```

### Memory Management
```bash
POST /memory/save      # Store memory entries (requires confirmation)
GET  /memory/load      # Retrieve memory by key
GET  /memory/health    # Memory system status
GET  /memory/list      # List all memory entries
```

### System Control
```bash
GET  /workers/status   # Worker system status
GET  /status          # Backend state information
POST /heartbeat       # System heartbeat (requires confirmation)
```

### Module Router
```bash
POST /query           # Dispatch to a module by name (e.g. tutor, gaming)
POST /tutor           # Tutor module (requires identifier ARCANOS:TUTOR)
POST /gaming          # Gaming module (requires identifier ARCANOS:GAMING)
```

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
  -d '{"key": "preference", "value": "dark_mode"}'

# Health check
curl http://localhost:8080/health
```

## 🛡️ Security & Compliance

### Confirmation Requirements
Most sensitive operations require explicit user confirmation via the `x-confirmed: yes` header to ensure compliance with OpenAI's Terms of Service.

**Protected Endpoints** (require confirmation):
- Data modification operations (`/memory/save`, `/memory/delete`)
- Worker execution (`/workers/run/*`)  
- System control (`/orchestration/*`, `/heartbeat`)
- AI processing with side effects (`/arcanos`, `/brain`)

**Safe Endpoints** (no confirmation needed):
- Read operations (`/health`, `/status`, `/memory/load`)
- Primary AI endpoint (`/ask`)
- Diagnostic endpoints (`/memory/health`, `/workers/status`)

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
├── config/            # Configuration management
├── routes/            # API route handlers
├── services/          # Core business logic
├── logic/             # AI reasoning and processing
├── utils/             # Utility functions
└── types/             # TypeScript type definitions

docs/                  # Documentation
├── ai-guides/         # AI-specific documentation
└── deployment/        # Deployment guides
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