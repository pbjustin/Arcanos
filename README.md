# Arcanos Backend

An AI-controlled TypeScript backend featuring fine-tuned OpenAI model integration, intelligent routing, and persistent memory storage. Arcanos provides a comprehensive HTTP API that is orchestrated entirely by an AI model with advanced worker scheduling and memory management.

## 🧠 Core Features

- **AI-Managed Operations**: Fine-tuned GPT model controls all system operations
- **Intelligent Memory System**: PostgreSQL backend with in-memory fallback 
- **OpenAI SDK v5.16.0**: Modern integration with streaming, function calling, and GPT-5 support
- **Image Generation**: DALL·E support via OpenAI's Images API with AI-refined prompts
- **Worker System**: AI-controlled CRON scheduling for maintenance and background tasks
- **Railway Optimized**: Cloud deployment ready with health monitoring and graceful shutdown

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

## ⚙️ Configuration

### Required Environment Variables
```bash
OPENAI_API_KEY=your-openai-api-key-here
AI_MODEL=REDACTED_FINE_TUNED_MODEL_ID
```

### Optional Configuration
```bash
PORT=8080
DATABASE_URL=postgresql://user:pass@localhost:5432/arcanos
RUN_WORKERS=true
```

**📖 Complete configuration guide:** [docs/CONFIGURATION.md](docs/CONFIGURATION.md)

## 🌐 API Documentation

Core endpoints:
- `POST /ask` - AI conversation and logic routing
- `POST /query-finetune` - Direct fine-tuned model access  
- `POST /image` - AI-enhanced image generation
- `GET /health` - System health check
- `POST /api/memory/*` - Memory management (requires confirmation)

**📖 Complete API reference:** [docs/api/README.md](docs/api/README.md)

## 🚄 Railway Deployment

### Quick Deploy
1. **Fork this repository** to your GitHub account
2. **Connect to Railway**: Go to [Railway.app](https://railway.app) → "Deploy from GitHub repo"
3. **Set environment variables**:
   ```bash
   OPENAI_API_KEY=your-openai-api-key-here
   NODE_ENV=production
   AI_MODEL=REDACTED_FINE_TUNED_MODEL_ID
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

**⚡ Quick Links:**
- [Configuration](docs/CONFIGURATION.md) | [API Docs](docs/api/README.md) | [Deploy to Railway](docs/deployment/DEPLOYMENT.md)
- [Health Check](http://localhost:8080/health) | [System Status](http://localhost:8080/status)