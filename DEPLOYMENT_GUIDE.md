# ARCANOS Railway Deployment Guide

🚀 **Status**: Production Ready ✅

This guide covers deploying ARCANOS to Railway with full OpenAI SDK integration and CI/CD pipeline.

## 🎯 Pre-Deployment Checklist

### ✅ Requirements Met
- [x] **OpenAI SDK v5.16.0**: Latest version with proper error handling
- [x] **Railway Configuration**: Dockerfile, Procfile, and environment setup
- [x] **Clean Architecture**: Modular codebase with proper separation
- [x] **Comprehensive Testing**: Unit and integration tests with CI/CD
- [x] **Environment Validation**: Robust configuration management
- [x] **Health Monitoring**: Built-in health checks for Railway

### ✅ CI/CD Pipeline
- [x] **Automated Testing**: Runs on every push and PR
- [x] **Type Checking**: TypeScript validation
- [x] **Linting**: Code style enforcement
- [x] **Security Auditing**: Dependency vulnerability scanning
- [x] **Docker Build**: Railway deployment validation
- [x] **Railway Compatibility**: Environment and configuration checks

## 🚄 Railway Deployment

### 1. Quick Deploy
1. **Fork this repository** to your GitHub account
2. **Connect to Railway**: [railway.app](https://railway.app) → "Deploy from GitHub repo"
3. **Select your forked repository**

### 2. Environment Variables
Set these in Railway dashboard:

#### Required:
```bash
OPENAI_API_KEY=sk-your-openai-key-here
NODE_ENV=production
```

#### Railway-Specific:
```bash
PORT=8080                    # Auto-set by Railway
RAILWAY_ENVIRONMENT=production  # Auto-set by Railway
```

#### Railway Management (optional but recommended):
```bash
RAILWAY_API_TOKEN=your-railway-api-token   # Enables deploy/rollback automation via GraphQL API
```

#### Fine-Tuned Model (Railway Compatible):
```bash
FINETUNED_MODEL_ID=ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote
# OR
AI_MODEL=REDACTED_FINE_TUNED_MODEL_ID
```

#### Optional (for full functionality):
```bash
DATABASE_URL=postgresql://user:pass@host:port/db  # Railway PostgreSQL
RUN_WORKERS=true
NOTION_API_KEY=your-notion-key
WWE_DATABASE_ID=your-notion-database-id
```

### 3. Deployment Process
Railway will automatically:
- **Install dependencies** (`npm ci`)
- **Build TypeScript** (`npm run build`)
- **Start the server** (`npm start`)
- **Bind to correct port** (Railway's `PORT` env var)
- **Enable health checks** (`/health` endpoint)

## 🔧 Local Development

### Prerequisites
- Node.js ≥ 18.0.0
- npm ≥ 8.0.0

### Setup
```bash
# Clone and install
git clone <repo-url>
cd Arcanos
npm install

# Setup environment
cp .env.example .env
# Edit .env with your OpenAI API key

# Development mode
npm run dev

# Production simulation
npm run build
npm start
```

### Available Scripts
```bash
npm run dev          # Development with TypeScript compilation
npm run build        # Build for production
npm run test         # Run all tests
npm run test:unit    # Unit tests only
npm run test:integration  # Integration tests only
npm run lint         # Code linting
npm run type-check   # TypeScript validation
npm run validate:railway  # Railway compatibility check
```

## 🧪 Testing & Validation

### Automated Tests
- **Unit Tests**: Core functionality validation
- **Integration Tests**: OpenAI SDK and Railway compatibility
- **Health Checks**: Service status and monitoring
- **Environment Validation**: Configuration and setup verification

### Manual Validation
```bash
# Test build and deployment readiness
npm run build
npm run test:all
npm run validate:railway

# Test Docker build (Railway uses Docker)
docker build -t arcanos-test .
```

## 📊 Monitoring

### Health Endpoints
- `/health` - Server health and status
- `/api/memory/health` - Memory service status
- `/api/sim/health` - Simulation service status

### Logging
- **Structured JSON logging** for Railway log aggregation
- **Request tracking** with unique IDs
- **Performance metrics** and error boundaries
- **Circuit breaker** status for API resilience

## 🛡️ Production Considerations

### Security
- ✅ **Rate limiting**: 50-100 requests per 15 minutes per endpoint
- ✅ **Input validation**: Comprehensive sanitization and validation
- ✅ **API key validation**: Proper format and authentication checks
- ✅ **Error boundaries**: Safe fallbacks for all failure modes

### Performance
- ✅ **Circuit breaker**: Prevents cascade failures
- ✅ **Response caching**: 5-minute cache for API responses
- ✅ **Memory optimization**: Docker build optimized for Railway
- ✅ **Graceful shutdown**: Proper SIGTERM handling

### Resilience
- ✅ **Mock responses**: Graceful degradation when API unavailable
- ✅ **Database fallback**: In-memory storage when PostgreSQL unavailable
- ✅ **Environment validation**: Startup failure prevention
- ✅ **Health monitoring**: Railway-compatible status checks

## 🔄 Deployment Workflow

### Manual Deployment
1. Push changes to `main` branch
2. Railway automatically detects and deploys
3. Monitor deployment in Railway dashboard
4. Check health endpoints for service status

### CI/CD Automation
- **Every Push**: Runs tests, linting, and validation
- **Every PR**: Full CI pipeline with deployment readiness checks
- **Production Deploy**: Automated via Railway integration

## 🐛 Troubleshooting

### Common Issues

#### 1. API Key Issues
```bash
# Error: "Invalid API key format"
# Solution: Ensure API key starts with 'sk-' and is properly formatted
OPENAI_API_KEY=sk-your-actual-key-here
```

#### 2. Port Binding Issues
```bash
# Error: "Port already in use"
# Solution: Railway automatically sets PORT, don't override
# Leave PORT unset locally, Railway will provide it
```

#### 3. Database Connection Issues
```bash
# Warning: "Database not available"
# Solution: Either provide DATABASE_URL or use in-memory fallback
# App continues to work with in-memory storage
```

#### 4. Environment Validation Failures
```bash
# Error: "Environment validation failed"
# Solution: Check the validation output for specific missing variables
npm run validate:railway  # See detailed validation results
```

### Debug Commands
```bash
# Check environment setup
npm run validate:railway

# Test API integration
npm run test:integration

# Check build process
npm run build && npm start

# View health status
curl http://localhost:8080/health
```

## 📈 Success Metrics

### Deployment Success Indicators
- ✅ Server starts without errors
- ✅ Health endpoints return 200 OK
- ✅ Environment validation passes
- ✅ OpenAI SDK initializes correctly
- ✅ Database fallback works if needed

### Production Readiness
- ✅ All tests passing
- ✅ Docker build successful  
- ✅ Railway validation complete
- ✅ CI/CD pipeline functional
- ✅ Monitoring and logging operational

---

## 🎉 Deployment Complete!

Your ARCANOS backend is now **production-ready** and **Railway-compatible** with:
- Modern OpenAI SDK v5+ integration
- Comprehensive CI/CD pipeline
- Robust error handling and fallbacks
- Professional monitoring and logging
- Enterprise-grade security and validation

**Deploy with confidence!** 🚀