# 🧠 GPT DIAGNOSTICS PROMPT LANGUAGE - ARCANOS IMPLEMENTATION

ARCANOS now supports natural language diagnostic commands for comprehensive system monitoring and health checks. This feature enables GPT and other AI systems to request specific diagnostics using human-readable commands.

## 🔋 MEMORY DIAGNOSTICS

### Commands:
- "Check available memory"
- "Show RAM usage" 
- "Run memory diagnostics"
- "How much memory is free vs. used?"
- "Memory usage in gigabytes"

### Response Format:
```json
{
  "success": true,
  "command": "Check available memory",
  "category": "memory",
  "data": {
    "process": {
      "rss": 62734336,
      "heapTotal": 10985472,
      "heapUsed": 10379800,
      "external": 3375771,
      "arrayBuffers": 65892
    },
    "system": {
      "totalMemory": 8330162176,
      "freeMemory": 7127126016,
      "usedMemory": 1203036160,
      "usagePercentage": "14.44"
    },
    "formatted": {
      "processRSS": "59.83 MB",
      "processHeap": "9.90 MB / 10.48 MB",
      "systemTotal": "7.76 GB",
      "systemFree": "6.64 GB",
      "systemUsed": "1.12 GB"
    }
  },
  "timestamp": "2025-07-20T08:14:49.207Z"
}
```

## ⚙️ CPU PERFORMANCE

### Commands:
- "Run CPU performance check"
- "How busy is the processor?"
- "Show CPU core usage"
- "CPU load average for the last 5 minutes"
- "Run real-time CPU diagnostics"

### Response Format:
```json
{
  "success": true,
  "command": "Run CPU performance check",
  "category": "cpu",
  "data": {
    "cores": 2,
    "model": "AMD EPYC 7763 64-Core Processor",
    "loadAverage": {
      "1min": 0.27,
      "5min": 0.23,
      "15min": 0.11
    },
    "usage": {
      "user": "2.15",
      "system": "1.32",
      "total": "3.47"
    },
    "formatted": {
      "cores": "2 cores",
      "model": "AMD EPYC 7763 64-Core Processor",
      "loadAvg5min": "0.23",
      "systemUptime": "0h 4m"
    }
  }
}
```

## 📦 DISK & STORAGE

### Commands:
- "Disk usage report"
- "Check available disk space"
- "How much storage is used?"
- "List largest directories or files"

### Response Format:
```json
{
  "success": true,
  "command": "Disk usage report",
  "category": "disk",
  "data": {
    "disk": {
      "filesystem": "/dev/sda1",
      "size": "20G",
      "used": "5.2G",
      "available": "14G",
      "usePercentage": "27%",
      "mountpoint": "/"
    },
    "formatted": {
      "totalSpace": "20G",
      "usedSpace": "5.2G",
      "availableSpace": "14G",
      "usagePercentage": "27%"
    }
  }
}
```

## 🌐 NETWORK & I/O

### Commands:
- "Network speed test"
- "Current bandwidth usage"
- "Show active network connections" 
- "Monitor open ports or listeners"

### Response Format:
```json
{
  "success": true,
  "command": "Show active network connections",
  "category": "network",
  "data": {
    "interfaces": {
      "eth0": [
        {
          "address": "10.0.0.5",
          "family": "IPv4",
          "internal": false,
          "mac": "00:16:3e:12:34:56"
        }
      ]
    },
    "activeConnections": [
      {
        "protocol": "tcp",
        "localAddress": "0.0.0.0:8080",
        "state": "LISTEN"
      }
    ],
    "formatted": {
      "interfaces": "eth0, lo",
      "activeConnectionCount": "5"
    }
  }
}
```

## 🧩 SYSTEM STATUS

### Commands:
- "Full system health check"
- "List all active processes"
- "Uptime and resource summary"
- "Run a diagnostic sweep"

### Response Format:
```json
{
  "success": true,
  "command": "Full system health check",
  "category": "system",
  "data": {
    "system": {
      "platform": "linux",
      "arch": "x64",
      "hostname": "arcanos-server",
      "uptime": 24560,
      "nodeVersion": "v18.17.0"
    },
    "memory": { /* memory data */ },
    "cpu": { /* cpu data */ },
    "disk": { /* disk data */ },
    "network": { /* network data */ },
    "healthStatus": "HEALTHY",
    "formatted": {
      "platform": "linux x64",
      "uptime": "6h 49m",
      "hostname": "arcanos-server",
      "processCount": "127 processes"
    }
  }
}
```

## 🚀 API ENDPOINTS

### 1. Direct Diagnostics API
```bash
POST /api/diagnostics
Content-Type: application/json

{
  "command": "Check available memory"
}
```

### 2. ARCANOS Router (with Intent Analysis)
```bash
POST /api/arcanos
Content-Type: application/json

{
  "message": "Run CPU performance check"
}
```

### 3. Main Root Endpoint
```bash
POST /
Content-Type: application/json

{
  "message": "Full system health check"
}
```

## ✅ INSTRUCTION PROTOCOL

**Always issue diagnostic prompts as direct, action-oriented commands.** Avoid meta-queries like "Can you check..." or "Give me a prompt that..." — just state the diagnostic task clearly.

### ✅ Good Examples:
- "Check available memory"
- "Run CPU performance check"
- "Show network connections"
- "Full system health check"

### ❌ Avoid:
- "Can you check the memory?"
- "Give me a command to check CPU"
- "I need to see the disk usage"

## 🔧 Integration with ARCANOS

The diagnostics service is fully integrated with the ARCANOS intent-based routing system:

1. **Intent Analysis**: Diagnostic commands are automatically detected and routed to `ARCANOS:DIAGNOSTIC`
2. **Router Integration**: Works through `/api/arcanos` endpoint with full intent analysis
3. **Fallback Support**: Available through direct API and root endpoint
4. **Error Handling**: Graceful handling of unrecognized commands

## 🎯 Health Status Indicators

The system calculates overall health status based on:
- **Memory Usage** < 80% = Healthy
- **CPU Load** < 80% of available cores = Healthy  
- **Disk Usage** < 90% = Healthy

Status levels: `HEALTHY`, `WARNING`, `CRITICAL`

## 📊 Monitoring Integration

Perfect for:
- **GPT-4 Custom Instructions**: System monitoring and health checks
- **Automated Monitoring**: Scheduled health checks via API
- **Development Tools**: Real-time system diagnostics during development
- **Production Monitoring**: Lightweight system health monitoring

This implementation provides comprehensive system diagnostics through natural language commands, making it ideal for GPT-based monitoring and management systems.