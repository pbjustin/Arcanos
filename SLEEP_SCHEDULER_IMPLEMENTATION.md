# ARCANOS Server Sleep and Maintenance Scheduler

## Overview

This implementation provides a comprehensive server sleep and maintenance scheduler for the ARCANOS backend, meeting all the specified requirements with enhanced functionality and robust error handling.

## 📅 Sleep Schedule

**Sleep Window:** 7:00 AM to 2:00 PM Eastern Time (daily)
- Automatic Daylight Saving Time (DST) handling
- Real-time sleep window detection
- Server activity reduction during sleep periods
- Container remains alive throughout sleep cycle

## 🔧 Core Features

### 1. Sleep Window Management (`src/services/sleep-config.ts`)
- **Eastern Time Detection:** Accurate timezone conversion with DST support
- **Sleep Status API:** Real-time status checking and next window calculations
- **Activity Reduction Logic:** Determines when to reduce server activity

### 2. Sleep Manager Service (`src/services/sleep-manager.ts`)
- **Centralized Orchestration:** Manages all sleep and maintenance operations
- **Status Logging:** Periodic sleep status reports (configurable interval)
- **Maintenance Coordination:** Schedules and executes sleep-specific tasks
- **Error Handling:** Comprehensive fallback mechanisms with retry logic

### 3. Enhanced Workers

#### Memory Sync Worker (`workers/memorySync.js`)
- **Standard Sync:** Regular memory synchronization operations
- **Sleep Enhancement:** Creates detailed memory snapshots during sleep window
- **Metrics Collection:** Tracks RSS, heap usage, and memory record counts

#### Goal Watcher Worker (`workers/goalWatcher.js`)
- **Goal Monitoring:** Standard goal tracking and reporting
- **Backlog Audit:** Sleep-specific comprehensive backlog analysis
- **Stale Detection:** Identifies and reports goals needing attention

#### Temp Cleaner Worker (`workers/clearTemp.js`)
- **Basic Cleanup:** Memory garbage collection and temp file removal
- **Log Cleanup:** Sleep-specific log file and directory cleanup
- **Old Record Removal:** Database cleanup for aged temporary records

#### Code Improvement Worker (`workers/codeImprovement.js`) - **NEW**
- **Daily Suggestions:** Generates 6 categories of improvement suggestions
- **Categories:** Performance, Security, Error Handling, Monitoring, Testing, Code Organization
- **Priority Ranking:** Assigns priority levels and impact estimates
- **Storage:** Saves suggestions for later review with detailed metadata

## ⏰ CRON Scheduling

### During Sleep Window (7 AM - 2 PM ET)
```
Every 2 hours  → Memory sync & snapshot
Every 1 hour   → Goal watcher & backlog audit  
Every 3 hours  → Temp cleanup & log cleanup
Once at 9 AM ET → Daily code improvement suggestions
```

### Outside Sleep Window
```
Every 15 minutes → Health checks
Every 6 hours    → General maintenance
Every 4 hours    → Standard memory sync
Every 30 minutes → Goal monitoring
```

## 🌐 API Endpoints

### Sleep Status Endpoint
```http
GET /system/sleep
```
Returns comprehensive sleep window information:
```json
{
  "sleepWindow": {
    "active": false,
    "timeZone": "America/New_York",
    "windowHours": "7:00 AM - 2:00 PM ET",
    "nextSleepStart": "2025-07-25T11:00:00.000Z",
    "nextSleepEnd": "2025-07-25T18:00:00.000Z",
    "timeUntilSleep": 206,
    "timeUntilWake": null
  },
  "serverMode": {
    "reducedActivity": false,
    "maintenanceTasksActive": false,
    "currentTime": "2025-07-25T03:33:00.000Z"
  },
  "manager": {
    "initialized": true,
    "status": "active"
  }
}
```

### Enhanced Performance Endpoint
```http
GET /performance
```
Now includes sleep status information in response.

### Sleep Status Logging
```http
POST /system/sleep/log
```
Forces immediate sleep status logging for debugging.

## 🚦 Server Activity Reduction

### During Sleep Window
- **Non-essential requests:** 100ms delay added
- **Essential endpoints:** Unaffected (health, performance, system APIs)
- **Response headers:** Added to indicate sleep mode
  ```
  X-Sleep-Mode: active
  X-Sleep-Window: 7AM-2PM-ET
  ```

### Essential Endpoints (Always Fast)
- `/health` - Health checks
- `/performance` - Performance monitoring  
- `/system/*` - System management APIs
- `GET /` - Root endpoint

## 🛡️ Error Handling & Fallbacks

### Retry Logic
- **30-minute fallback:** Failed maintenance tasks retry automatically
- **Duration tracking:** All tasks log execution time
- **Status monitoring:** Worker status service tracks all operations

### Graceful Degradation
- **Mock responses:** Available when external services unavailable
- **In-memory fallback:** Database operations continue without PostgreSQL
- **Service isolation:** Failed services don't affect others

### Comprehensive Logging
```
[SLEEP-WINDOW] 🌅 Currently awake (outside 7 AM - 2 PM ET)
[SLEEP-WINDOW] ⏰ Sleep in 206 minutes at 7/25/2025, 7:00:00 AM
[SLEEP-MAINTENANCE] 🔧 Starting memory-sync-snapshot during sleep window
[SLEEP-MAINTENANCE] ✅ memory-sync-snapshot completed successfully in 1247ms
```

## 🧪 Testing

### Test Files Created
- `test-sleep-window.js` - Sleep window functionality verification
- `test-workers.js` - Enhanced worker functionality testing
- `test-comprehensive.js` - Complete system integration test
- `test-sleep-api.js` - API endpoint testing

### Test Results
- ✅ Sleep window detection accuracy
- ✅ Eastern Time conversion with DST
- ✅ All enhanced workers functional
- ✅ Activity reduction middleware working
- ✅ API endpoints responding correctly
- ✅ Fallback mechanisms operational

## 🚀 Deployment

### Environment Variables
```bash
OPENAI_API_KEY=your_key_here
DATABASE_URL=postgresql://user:pass@host:port/db
ARCANOS_API_TOKEN=your_token_here
NODE_ENV=production
PORT=8080
RUN_WORKERS=true  # Enable background workers
```

### Build & Start
```bash
npm run build
npm start
```

## 📊 Monitoring

### Key Metrics
- Sleep window status and timing
- Maintenance task success/failure rates
- Worker execution duration
- Memory usage during snapshots
- Cleanup statistics (files removed, space freed)
- Code improvement suggestion generation

### Log Categories
- `[SLEEP-WINDOW]` - Sleep status and timing
- `[SLEEP-MAINTENANCE]` - Maintenance task execution
- `[AI-MEMORY-SYNC]` - Memory operations
- `[AI-GOAL-WATCHER]` - Goal monitoring and audits
- `[AI-TEMP-CLEANER]` - Cleanup operations
- `[AI-CODE-IMPROVEMENT]` - Suggestion generation

## 🎯 Implementation Summary

**All Requirements Met:**
- ✅ Sleep window: 7:00 AM to 2:00 PM Eastern Time daily
- ✅ Server activity reduction while keeping container alive
- ✅ Background maintenance tasks during sleep
- ✅ CRON jobs and setInterval usage
- ✅ Comprehensive logging for all tasks
- ✅ Fallback handling for failed tasks

**Additional Enhancements:**
- ✅ Real-time sleep window API monitoring
- ✅ Automatic DST handling
- ✅ Code improvement suggestions worker
- ✅ Enhanced worker capabilities
- ✅ Comprehensive test suite
- ✅ Activity reduction middleware
- ✅ Detailed metrics and monitoring