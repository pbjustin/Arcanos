# Arcanos Backend

> **Last Updated:** 2024-09-27 | **Version:** 1.2.0 | **OpenAI SDK:** v5.16.0

An AI-controlled TypeScript backend featuring fine-tuned OpenAI model integration, intelligent routing, and persistent memory storage. Arcanos provides a comprehensive HTTP API that is orchestrated entirely by an AI model with advanced worker scheduling and memory management.

## 📋 Documentation Self-Check

This README.md includes the following required sections:
- [x] Architecture overview and configuration patterns
- [x] Environment variables with fallback behaviors documented
- [x] API endpoints with confirmation requirements
- [x] Deployment procedures with Railway optimization
- [x] Development workflow and project structure
- [x] Last-updated tags and version information
- [x] Links to comprehensive documentation in `/docs`

## 🧠 Core Architecture & Features

### AI-Controlled Architecture
- **AI-Managed Operations**: Fine-tuned GPT model controls all system operations
- **Intelligent Memory System**: PostgreSQL backend with in-memory fallback behavior
- **OpenAI SDK v5.16.0**: Modern integration with streaming, function calling, and GPT-5 support
- **Image Generation**: DALL·E support via OpenAI's Images API with AI-refined prompts
- **Worker System**: AI-controlled CRON scheduling for maintenance and background tasks
- **Railway Optimized**: Cloud deployment ready with health monitoring and graceful shutdown

### Fallback Behaviors
- **Database**: Automatically falls back to in-memory storage if PostgreSQL unavailable
- **AI Services**: Provides mock responses when OpenAI API key is not configured
- **Worker System**: Continues core operations even if background workers fail
- **Health Monitoring**: Degrades gracefully with detailed status reporting via `/health`

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm 8+
- PostgreSQL (optional - uses in-memory fallback)
- OpenAI API key

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
# Health check
curl http://localhost:8080/health

# AI chat
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, how are you?"}'

# Generate an image
curl -X POST http://localhost:8080/image \
  -H "Content-Type: application/json" \
  -d '{"prompt": "A futuristic AI assistant"}'
```

## 🛡️ Environment Safety

ARCANOS includes comprehensive environment validation and security features. On startup, the system:
- Validates environment configuration
- Runs security checks in sandbox mode  
- Provides detailed health status via `/health` endpoint
- Switches to safe mode if any issues are detected

For details, see [Environment Security Overview](docs/environment-security-overview.md).

## ⚙️ Configuration Patterns

### Required Environment Variables
```bash
OPENAI_API_KEY=your-openai-api-key-here
AI_MODEL=ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH
```

### Optional Configuration with Fallbacks
```bash
PORT=8080                          # Fallback: 8080
DATABASE_URL=postgresql://...      # Fallback: In-memory storage
RUN_WORKERS=true                   # Fallback: false (core services only)
NODE_ENV=production                # Fallback: development
RAILWAY_ENVIRONMENT=production     # Fallback: local
```

### Configuration Validation
The system performs comprehensive environment validation on startup:
- **Missing required vars**: System starts in safe mode with mock responses  
- **Invalid format**: Detailed error messages with correction guidance
- **Database connectivity**: Automatic fallback to in-memory storage
- **OpenAI API**: Validates API key format and connectivity

**📖 Complete configuration guide:** [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## 🌐 API Documentation & Endpoints

### Core Endpoints
- `POST /ask` - AI conversation and logic routing (no confirmation required)
- `POST /query-finetune` - Direct fine-tuned model access (no confirmation required)
- `POST /image` - AI-enhanced image generation (no confirmation required)
- `GET /health` - System health check and status (no confirmation required)

### Protected Endpoints (Require Confirmation Header)
- `POST /api/memory/*` - Memory management operations
- `DELETE /api/memory/*` - Memory deletion operations  
- `POST /api/workers/*` - Worker system management

### Confirmation Gate Pattern
Protected endpoints require the `X-Confirmation` header:
```bash
curl -X POST http://localhost:8080/api/memory/create \
  -H "Content-Type: application/json" \
  -H "X-Confirmation: confirmed" \
  -d '{"key": "example", "value": "data"}'
```

**📖 Complete API reference:** [docs/api/README.md](docs/api/README.md)

## 🚄 Railway Deployment

### Quick Deploy
1. **Fork this repository** to your GitHub account
2. **Connect to Railway**: Go to [Railway.app](https://railway.app) → "Deploy from GitHub repo"
3. **Set environment variables**:
   ```bash
   OPENAI_API_KEY=your-openai-api-key-here
   NODE_ENV=production
   AI_MODEL=ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH
   ```

**📖 Complete deployment guide:** [docs/deployment/DEPLOYMENT.md](docs/deployment/DEPLOYMENT.md)

## 🔧 Development

### Available Scripts
```bash
npm run build       # Build TypeScript
npm run dev         # Development server
npm run test        # Run tests
npm run lint        # Lint code
npm start          # Start production server
```

### Project Structure
```
src/
├── config/         # Configuration and environment
├── services/       # Core services (OpenAI, memory, etc.)
├── routes/         # API route handlers
├── utils/          # Utilities and helpers
├── logic/          # AI logic implementations
└── middleware/     # Express middleware
```

**📖 Development guides:** [docs/](docs/)

## 🧹 Recent Optimizations

This repository has been optimized for **OpenAI SDK + Railway deployment**:

✅ **Updated Dependencies** - OpenAI SDK v5.16.0, ESLint v9, modern TypeScript  
✅ **Environment Variables** - Centralized configuration, removed hardcoded values  
✅ **Code Quality** - Simplified routing, improved TypeScript safety, structured logging  
✅ **Worker System** - AI-controlled background processes with health monitoring

## 📚 Documentation

### Core Guides
- [Configuration Guide](docs/CONFIGURATION.md) - Environment variables and settings
- [API Reference](docs/api/README.md) - Complete endpoint documentation  
- [Deployment Guide](docs/deployment/DEPLOYMENT.md) - Railway, Docker, and production setup
- [Backend Architecture](docs/backend.md) - Technical architecture details

### AI Features  
- [OpenAI Integration](docs/GPT5_INTEGRATION_SUMMARY.md) - GPT-5 and fine-tuned model usage
- [Memory System](docs/pinned-memory-guide.md) - Persistent memory and context management
- [Worker System](docs/ai-guides/) - AI-controlled background processes

### Development
- [Environment Security](docs/environment-security-overview.md) - Security and validation features
- [PR Assistant](docs/PR_ASSISTANT_README.md) - Automated code review and validation

## 📝 License

MIT License - see LICENSE file for details.

---

## 📋 Version History & Maintenance

- **v1.2.0** (2024-09-27): Complete documentation standardization and audit system
- **v1.1.0** (2024-09-24): OpenAI SDK v5.16.0 upgrade and Railway optimization  
- **v1.0.0** (2024-09-20): Initial release with AI-controlled architecture

### Documentation Maintenance
This documentation is validated by:
- Automated lint checks in CI/CD pipeline
- Documentation audit script (`scripts/doc_audit.sh`)
- GitHub Actions workflow for consistency verification
- Self-check procedures embedded in each file

**⚡ Quick Links:**
- [Configuration](docs/CONFIGURATION.md) | [API Docs](docs/api/README.md) | [Deploy to Railway](docs/deployment/DEPLOYMENT.md)
- [Health Check](http://localhost:8080/health) | [System Status](http://localhost:8080/status) | [Audit Script](scripts/doc_audit.sh)