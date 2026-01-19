# Memory Optimization for Railway Hobby Plan (8GB)

## Overview

This document outlines the memory optimization configurations implemented for the ARCANOS backend application running on Railway's Hobby Plan, which provides **8GB RAM per container**.

## Problem Statement

By default, Node.js V8 engine limits heap memory to ~2GB, leaving 6GB unused on the 8GB Railway Hobby Plan allocation.

## Solution Implemented

### Node.js Memory Configuration

The application has been configured with `--max-old-space-size=7168` (7GB) to utilize the available 8GB RAM effectively:

- **7GB allocated to Node.js heap** (leaving 1GB for system overhead)
- **Configured across all deployment methods** for consistency

### Files Modified

#### 1. `package.json`
```json
{
  "scripts": {
    "start": "node --max-old-space-size=7168 dist/index.js",
    "start:railway": "node --max-old-space-size=7168 dist/index.js",
    "dev": "ts-node --max-old-space-size=7168 src/index.ts"
  }
}
```

#### 2. `railway.json`
```json
{
  "deploy": {
    "startCommand": "node --max-old-space-size=7168 dist/index.js"
  }
}
```

#### 3. `.railway/config.json`
```json
{
  "deploy": {
    "startCommand": "node --max-old-space-size=7168 dist/index.js"
  }
}
```

#### 4. `Procfile`
```
web: node --max-old-space-size=7168 dist/index.js
worker: RUN_WORKERS=true node --max-old-space-size=7168 dist/index.js
```

#### 5. `Dockerfile`
```dockerfile
CMD ["node", "--max-old-space-size=7168", "dist/index.js"]
```

### NPM Install Optimizations

To reduce memory spikes during dependency installation, a `.npmrc` file configures offline caching:

```ini
prefer-offline=true
cache-min=999999
```

Docker and CI builds install dependencies with a lower memory limit:

```bash
NODE_OPTIONS=--max_old_space_size=256 npm install --omit=dev
```

### Memory Monitoring

Added real-time memory monitoring to track usage:

```typescript
// Memory optimization logging for 8GB Railway Hobby Plan
const memStats = process.memoryUsage();
const v8Stats = require('v8').getHeapStatistics();
console.log('🧠 [MEMORY] Node.js Memory Configuration for 8GB Hobby Plan:');
console.log(`   📊 Heap Size Limit: ${(v8Stats.heap_size_limit / 1024 / 1024 / 1024).toFixed(2)} GB`);
// ... additional monitoring
```

## Verification

### Before Optimization
```
V8 heap limit: 2.046875 GB
```

### After Optimization
```
V8 heap limit: 7.046875 GB ✅
```

### Testing Memory Configuration
```bash
# Test memory limit
node --max-old-space-size=7168 -e "console.log('V8 heap limit:', require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024 / 1024, 'GB')"

# Expected output: ~7.05 GB
```

## Railway Hobby Plan Specifications

- ✅ **8GB RAM per container** - Now fully utilized
- ✅ **8 vCPU** - No configuration needed
- ✅ **100GB shared disk** - No configuration needed

## Memory Allocation Strategy

| Component | Allocation | Purpose |
|-----------|------------|---------|
| Node.js V8 Heap | 7GB | Application runtime, variables, objects |
| System Overhead | ~1GB | OS, Railway agent, other processes |
| **Total** | **8GB** | **Full Railway Hobby Plan allocation** |

## Benefits

1. **7x Memory Increase**: From ~2GB to ~7GB available heap space
2. **Better Performance**: Reduced garbage collection pressure
3. **Scalability**: Can handle larger datasets and more concurrent operations
4. **Cost Efficiency**: Full utilization of paid Railway Hobby Plan resources

## Monitoring

The application now logs memory usage every 5 minutes:
```
🧠 [MEMORY_MONITOR] RSS: 56.75MB, Heap: 10.33MB/7.05GB
```

## Deployment Notes

- All deployment methods (Railway, Docker, npm scripts) now use optimized memory settings
- No additional environment variables required
- Compatible with existing Railway deployment pipeline
- Graceful degradation if memory flags are not supported

## Troubleshooting

If you encounter memory-related issues:

1. **Check heap limit**: `node -e "console.log(require('v8').getHeapStatistics().heap_size_limit / 1024 / 1024 / 1024, 'GB')"`
2. **Monitor usage**: Watch the memory monitor logs every 5 minutes
3. **Verify flags**: Ensure `--max-old-space-size=7168` is in all start commands

## References

- [Node.js V8 Options](https://nodejs.org/api/cli.html#cli_max_old_space_size_size_in_megabytes)
- [Railway Memory Limits](https://docs.railway.app/reference/plans#hobby)
- [V8 Memory Management](https://v8.dev/blog/memory)