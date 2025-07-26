# ARCANOS Deployment Guide

This guide helps you deploy the ARCANOS backend application successfully.

## Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- OpenAI API key
- Railway CLI (for Railway deployment)

## Memory Configuration for 8GB Hobby Plan

**✅ OPTIMIZED**: This application is configured to utilize the full 8GB RAM available on Railway's Hobby Plan.

- **Node.js heap limit**: 7GB (via `--max-old-space-size=7168`)
- **System overhead**: 1GB reserved
- **Monitoring**: Real-time memory usage logging enabled

See [MEMORY_OPTIMIZATION.md](MEMORY_OPTIMIZATION.md) for detailed configuration and monitoring information.

## Quick Deployment Check

Run this script to verify your deployment readiness:

```bash
# Install Railway CLI and check service status
npm install -g @railway/cli
railway login
railway init
railway status
railway logs

# Check if build output exists
echo "Checking for build output..."
ls dist/index.js || echo "❌ dist/index.js not found. Run 'npm run build'"

# Run local build to catch compile issues
echo "Running TypeScript build..."
npm install
npm run build || echo "❌ Build failed – check your tsconfig.json and src/index.ts"

# Verify required .env keys are set
echo "Verifying .env variables..."
cat .env | grep -E 'OPENAI_API_KEY|AI_MODEL|FINE_TUNE_MODEL|FINE_TUNED_MODEL|NODE_ENV|PORT' || echo "⚠️ Missing one or more required environment variables."

# Try running the app manually to catch runtime errors
echo "Starting server manually to catch errors..."
NODE_ENV=production node dist/index.js

# Final tip: Make sure your 'start' script in package.json is correct
echo "Ensure this exists in package.json scripts block:"
echo '"start": "node dist/index.js"'
echo "Note: NODE_ENV should be set as an environment variable, not in the start script"
```

## Environment Variables

Create a `.env` file with the following required variables:

```env
NODE_ENV=production
PORT=8080
OPENAI_API_KEY=your-openai-api-key-here
# Use the highest priority environment variable for your model
AI_MODEL=your-fine-tuned-model-id
# Or alternatively:
# FINE_TUNE_MODEL=your-fine-tuned-model-id
# FINE_TUNED_MODEL=your-fine-tuned-model-id
RUN_WORKERS=true
SERVER_URL=https://your-app.railway.app
GPT_TOKEN=your-gpt-diagnostic-token
```

## Build and Start

```bash
# Install dependencies
npm install

# Build the TypeScript project
npm run build

# Start the production server
# Note: The prestart script automatically runs npm install before starting
npm start
```

### Package.json Scripts

The following scripts are available:
- `npm run dev` - Start development server with hot reload (7GB memory allocation)
- `npm run build` - Build TypeScript to JavaScript (output to dist/)
- `npm start` - Start production server from compiled JavaScript (dist/index.js)
- `npm run start:railway` - Railway-specific start command (same as start)

**Note**: Make sure to run `npm run build` before `npm start` to ensure the compiled output exists in the `dist/` directory.

## Deployment Verification

After deployment, verify these endpoints work:

- `GET /health` - Health check endpoint
- `GET /api/` - Main API information endpoint  
- `POST /api/ask` - ARCANOS chat endpoint

## Railway Deployment

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Initialize project: `railway init`
4. Set environment variables in Railway dashboard:
   - `NODE_ENV=production`
   - `PORT=8080` (or let Railway auto-assign)
   - `OPENAI_API_KEY=your-openai-api-key`
   - `FINE_TUNED_MODEL=your-fine-tuned-model-id`
   - `RUN_WORKERS=true`
   - `SERVER_URL=https://your-app.railway.app`
5. Deploy: `railway up`

**Important**: Set `NODE_ENV=production` as an environment variable in Railway's dashboard, not in the start script.

## Docker Deployment

The application includes a `docker-compose.yml` file for containerized deployment with Docker Compose.

### Services

- **arcanos-core**: The main ARCANOS backend service (port 8080)
- **postgres**: PostgreSQL database for persistent memory storage

### Usage

```bash
# Build and start all services
docker compose up -d

# Build and start only arcanos-core
docker compose up -d arcanos-core

# View service status
docker compose ps

# View logs
docker compose logs

# Stop all services
docker compose down
```

### Resource Limits

The docker-compose configuration includes memory limits:
- **arcanos-core**: 512MB limit, 256MB reservation
- **postgres**: 256MB limit, 128MB reservation

### Prerequisites for Docker Deployment

- Docker and Docker Compose installed
- Environment variables configured in `.env` file

### Building Images

The `arcanos-core` service builds from the local Dockerfile. The PostgreSQL service uses the standard `postgres:16` image.

## Troubleshooting

### Common Issues and Solutions

**npm error: "command failed" / "signal SIGTERM"**
- **Cause**: Missing dependencies in `node_modules` directory
- **Solution**: Run `npm install` to ensure all dependencies are installed
- **Prevention**: The `prestart` script now automatically runs `npm install` before starting

**Build fails**
- **Cause**: TypeScript compilation errors or missing dependencies
- **Solution**: 
  1. Run `npm install` to ensure dependencies are present
  2. Check `tsconfig.json` and ensure all TypeScript files compile
  3. Run `npm run build` manually to see specific errors

**Server won't start**
- **Cause**: Missing environment variables or build output
- **Solution**: 
  1. Verify all required environment variables are set
  2. Ensure `dist/index.js` exists (run `npm run build` if missing)
  3. Check for runtime errors in the console

**API errors**
- **Cause**: Invalid configuration or missing API keys
- **Solution**: Check that `OPENAI_API_KEY` is valid and `FINE_TUNED_MODEL` exists

### Dependency Installation Issues

If you encounter missing dependency errors:

```bash
# Clean install all dependencies
rm -rf node_modules package-lock.json
npm install

# Or force reinstall specific packages
npm install dotenv openai express tsx typescript
```

### Build Process Verification

```bash
# Complete build verification
npm install
npm run build
ls dist/index.js  # Should exist
npm start  # Should start successfully
```