# Quick Start: Cross-Codebase Sync

## 🎯 The Concept

**Server (TypeScript)** = Source of Truth ⭐  
**Daemon (Python)** = Extension that follows server 🔄

When you work on the server, the system automatically tells you what the daemon needs to update!

## ⚡ 30-Second Setup

```bash
# Run sync check
npm run sync:check
```

That's it! The system will show you:
- ✅ What's in sync
- 🔴 What daemon needs to update (when server changes)
- 💡 Specific fixes with code suggestions

## 📋 Common Scenarios

### Scenario 1: You Add a New API Endpoint to Server

```typescript
// You add: src/routes/api-new-feature.ts
router.post('/api/new-feature', ...)
```

**Run:**
```bash
npm run sync:check
```

**System Shows:**
```
🔴 SERVER (source of truth) defines /api/new-feature
   DAEMON (extension) is missing 'request_new_feature()'
💡 Add request_new_feature() method to backend_client.py
```

**You:** Update daemon to match server ✅

### Scenario 2: You Change Server Schema

```typescript
// Server now requires 'priority' field
request: { message: string, priority: number }
```

**Run:**
```bash
npm run sync:check
```

**System Shows:**
```
🔴 SERVER requires 'priority' field
   DAEMON method missing 'priority' parameter
💡 Update request_chat_completion() to include priority
```

**You:** Update daemon method ✅

### Scenario 3: You Work on Daemon

```python
# You modify: daemon-python/backend_client.py
```

**Run:**
```bash
npm run sync:check
```

**System Shows:**
```
⚠️  Daemon method doesn't match server route
💡 Update to match server (source of truth)
```

**You:** Fix daemon to match server ✅

## 🛠️ Quick Commands

```bash
# Full sync check
npm run sync:check

# Check just dependencies
node scripts/sync-helper.js check-deps

# Check specific API
node scripts/sync-helper.js check-api /api/ask

# Sync version numbers
node scripts/sync-helper.js sync-version 1.0.1

# Watch mode (continuous)
npm run sync:watch
```

## 🎁 The Magic

**You work on server → System tells you what daemon needs**

No more:
- ❌ Forgetting to update daemon
- ❌ Manual checking
- ❌ Wondering what broke

Just:
- ✅ Work on server
- ✅ Run sync check
- ✅ System shows what daemon needs
- ✅ Update daemon
- ✅ Done!

## 📚 Learn More

- **Full Guide**: `docs/CROSS_CODEBASE_SYNC.md`
- **Architecture**: `docs/ARCHITECTURE_SOURCE_OF_TRUTH.md`
- **Features**: `docs/SYNC_FEATURES.md`

---

**Remember**: Server is source of truth. Daemon follows. System has your back! 🚀
