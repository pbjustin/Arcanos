# Quick Setup Guide for Arcanos API

This guide helps you get started with the Arcanos API quickly.

## Prerequisites

- Node.js 18+ installed
- npm 8+ installed
- OpenAI API account (optional for basic testing)

## Installation Steps

### 1. Clone and Install
```bash
git clone <repository-url>
cd Arcanos
npm install
```

### 2. Environment Configuration

Copy the example environment file:
```bash
cp .env.example .env
```

Edit `.env` file with your configuration:
```bash
# Required for AI features
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_FINE_TUNED_MODEL=your-fine-tuned-model-id

# Optional settings
PORT=8080
NODE_ENV=production
RUN_WORKERS=false
```

**Note**: The API will work partially without OpenAI credentials for testing basic functionality.

### 3. Build and Start
```bash
npm run build
npm start
```

Or for development with hot reloading:
```bash
npm run dev
```

## Verification

### Quick Test
```bash
# Test server is running
curl http://localhost:8080/health

# Test basic API
curl http://localhost:8080/api

# Test echo endpoint
curl -X POST http://localhost:8080/api/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello!"}'
```

### Run Full Test Suite
```bash
./test-api-endpoints.sh
```

## What Works Without API Key

- ✅ Health check (`/health`)
- ✅ API welcome (`/api`)
- ✅ Echo endpoint (`/api/echo`)
- ✅ Memory storage (`/api/memory`)
- ✅ HRC validation (`/api/ask-hrc`)
- ✅ Error handling for AI endpoints

## What Requires API Key

- ❌ AI chat endpoints (`/api/ask`, `/api/ask-with-fallback`)
- ❌ V1 Safe interface (`/api/ask-v1-safe`)
- ❌ ARCANOS router (`/api/arcanos`)

## Next Steps

1. **Read the documentation**: [PROMPT_API_GUIDE.md](./PROMPT_API_GUIDE.md)
2. **Try examples**: [PROMPT_API_EXAMPLES.md](./PROMPT_API_EXAMPLES.md)
3. **Configure OpenAI**: Add your API key to unlock AI features
4. **Integrate**: Use provided client examples for your applications

## Troubleshooting

### Port Already in Use
```bash
# Kill process on port 8080
lsof -ti:8080 | xargs kill -9

# Or use different port
PORT=3000 npm start
```

### Permission Errors
```bash
chmod +x test-api-endpoints.sh
```

### Build Errors
```bash
# Clear and reinstall dependencies
rm -rf node_modules package-lock.json
npm install
npm run build
```

## Support

- Check server logs for detailed error messages
- Use the test script to validate functionality
- Refer to the comprehensive guides for detailed usage

Happy coding! 🚀