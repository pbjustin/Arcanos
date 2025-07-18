# ARCANOS Deployment Guide

This guide helps you deploy the ARCANOS backend application successfully.

## Prerequisites

- Node.js 18+ installed
- npm or yarn package manager
- OpenAI API key
- Railway CLI (for Railway deployment)

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
cat .env | grep -E 'OPENAI_API_KEY|SESSION_SECRET|NODE_ENV|PORT' || echo "⚠️ Missing one or more required environment variables."

# Try running the app manually to catch runtime errors
echo "Starting server manually to catch errors..."
NODE_ENV=production node dist/index.js

# Final tip: Make sure your 'start' script in package.json is correct
echo "Ensure this exists in package.json scripts block:"
echo '"start": "node dist/index.js"'
```

## Environment Variables

Create a `.env` file with the following required variables:

```env
NODE_ENV=production
PORT=3000
OPENAI_API_KEY=your-openai-api-key-here
SESSION_SECRET=your-session-secret-here
FINE_TUNED_MODEL=your-fine-tuned-model-id
```

## Build and Start

```bash
# Install dependencies
npm install

# Build the TypeScript project
npm run build

# Start the production server
npm start
```

## Deployment Verification

After deployment, verify these endpoints work:

- `GET /health` - Health check endpoint
- `GET /api/` - Main API information endpoint  
- `POST /api/ask` - ARCANOS chat endpoint

## Railway Deployment

1. Install Railway CLI: `npm install -g @railway/cli`
2. Login: `railway login`
3. Initialize project: `railway init`
4. Set environment variables in Railway dashboard
5. Deploy: `railway up`

## Troubleshooting

- **Build fails**: Check `tsconfig.json` and ensure all TypeScript files compile
- **Server won't start**: Verify all required environment variables are set
- **API errors**: Check that `OPENAI_API_KEY` is valid and `FINE_TUNED_MODEL` exists