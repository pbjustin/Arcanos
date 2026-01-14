# Arcanos Deployment Guide

> **Note:** This is a quick reference. For the complete Railway deployment guide, see [`docs/RAILWAY_DEPLOYMENT.md`](docs/RAILWAY_DEPLOYMENT.md).

## Quick Start

Deploy Arcanos to Railway in minutes:

1. **Prerequisites**
   - Railway account
   - OpenAI API key
   - Node.js 18+ (for local testing)

2. **Deploy to Railway**
   ```bash
   # Connect to Railway
   railway login
   railway init
   
   # Set environment variables
   railway variables set OPENAI_API_KEY=sk-your-key-here
   
   # Deploy
   railway up
   ```

3. **Verify deployment**
   ```bash
   curl https://your-app.railway.app/health
   ```

## Detailed Documentation

For comprehensive deployment instructions, troubleshooting, and configuration:

**→ See [`docs/RAILWAY_DEPLOYMENT.md`](docs/RAILWAY_DEPLOYMENT.md)**

This guide covers:
- Pre-deployment checklist
- Environment variable configuration
- Health monitoring and logging
- Troubleshooting common issues
- Rollback procedures
- Success metrics

## Related Documentation

- [Configuration Guide](docs/CONFIGURATION.md) - Environment variables reference
- [API Reference](docs/api/README.md) - API endpoints and usage
- [README](README.md) - Project overview
- [Railway Compatibility Guide](RAILWAY_COMPATIBILITY_GUIDE.md) - Implementation details
