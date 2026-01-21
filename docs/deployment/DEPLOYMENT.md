# Arcanos Deployment Guide

> **Note:** For complete deployment instructions, see the canonical [Railway Deployment Guide](../RAILWAY_DEPLOYMENT.md).

This directory contains deployment-related technical documentation.

## Quick Links

**Primary Deployment Guide:**
- [Railway Deployment Guide](../RAILWAY_DEPLOYMENT.md) - Complete Railway deployment instructions

**Specialized Topics:**
- [PRISMA_SETUP.md](PRISMA_SETUP.md) - Database setup with Prisma

## Memory Configuration

Arcanos is optimized for Railway's Hobby Plan (8GB RAM):
- **Node.js heap limit:** 7GB (`--max-old-space-size=7168`)
- **System overhead:** 1GB reserved
- **Configuration:** Set in `railway.json` start command

The memory configuration is documented in the Railway deployment guide.

## Related Documentation

- [Configuration Guide](../CONFIGURATION.md) - Environment variables
- [API Reference](../api/README.md) - API endpoints
- [README](../../README.md) - Project overview
