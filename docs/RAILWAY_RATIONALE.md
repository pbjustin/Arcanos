# Why Arcanos Uses Railway for Cloud Deployment

This document explains the rationale for deploying Arcanos on Railway so the team can evaluate trade-offs and align operational decisions.

## Summary

Railway is the preferred deployment target because it offers a low-friction path from repository to production while preserving the operational controls we need for Arcanos (environment management, logs, health checks, and predictable runtime configuration).

## Key Reasons

### 1) Source-controlled deployment configuration
- Railway reads `railway.json` and `Procfile`, which keeps build and start behavior versioned alongside the application.
- This improves auditability and reduces drift between local, staging, and production environments.

### 2) Runtime environment consistency
- Railway injects required runtime variables like `PORT` and can manage database connections through Railway-managed services.
- This matches Arcanos runtime expectations and reduces custom bootstrapping logic.

### 3) Health checks and observability
- Railway supports health checks that align with Arcanos `/health` endpoint, enabling fast feedback on deploy status.
- Centralized logs streamline incident response and reduce the need for bespoke log aggregation in early stages.

### 4) Operational simplicity
- The deployment workflow is straightforward: connect the repo, set variables, and deploy.
- This reduces operational overhead and lets the team focus on product features rather than infrastructure maintenance.

### 5) Environment isolation and safety
- Railway environment variables and per-environment configuration help keep production, staging, and development settings isolated.
- This supports safer releases and easier rollback strategies.

### 6) Cost and velocity alignment
- Railway’s managed service approach optimizes for rapid iteration without requiring a dedicated platform engineering effort.
- It provides a good balance between cost and deployment velocity for the current stage of Arcanos.

## When to Re-evaluate

Revisit this decision if any of the following become primary constraints:
- Need for deeper network customization, advanced multi-region routing, or specialized compliance requirements.
- Cost structure changes that make self-managed infrastructure materially more efficient.
- Operational needs that exceed Railway’s deployment primitives.

## Related Documents

- [Railway Deployment Guide](RAILWAY_DEPLOYMENT.md)
- [Railway Compatibility Guide](../RAILWAY_COMPATIBILITY_GUIDE.md)
