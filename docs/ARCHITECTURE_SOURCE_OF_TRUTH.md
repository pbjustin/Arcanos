# ARCANOS Architecture: Source of Truth

## 🎯 Architecture Overview

ARCANOS follows a **Source of Truth** architecture:

```
┌─────────────────────────────────────┐
│  TypeScript Server (src/)           │
│  GitHub Repository                  │
│  ⭐ SOURCE OF TRUTH                 │
└──────────────┬──────────────────────┘
               │
               │ follows
               ▼
┌─────────────────────────────────────┐
│  Python Daemon (daemon-python/)     │
│  Local Extension                    │
│  🔄 EXTENSION (follows server)      │
└─────────────────────────────────────┘
```

## 📋 Key Principles

### 1. Server is Source of Truth
- **TypeScript Server** (`src/`) = Primary codebase
- Lives in **GitHub repository**
- Defines APIs, schemas, contracts
- **Daemon must follow server**

### 2. Daemon is Extension
- **Python Daemon** (`daemon-python/`) = Extension
- Installed locally on user's PC
- **Follows server** - cannot define new APIs
- Implements server APIs as client

### 3. Direction of Changes

**Server → Daemon (Required)**
- Server changes **require** daemon updates
- New API endpoints → daemon must implement
- Schema changes → daemon must update
- Breaking changes → daemon must adapt

**Daemon → Server (Rare)**
- Daemon can request features
- But server defines the contract
- Daemon cannot break server contracts

## 🔄 Sync System Behavior

### When Server Changes
1. **Detect** server changes (new routes, schema updates)
2. **Identify** what daemon needs to update
3. **Suggest** specific daemon changes
4. **Prioritize** as HIGH - daemon must follow

### When Daemon Changes
1. **Check** if changes match server
2. **Warn** if daemon diverges from server
3. **Suggest** server updates only if daemon needs new features

## 📊 What Gets Synced

### API Contracts (Server → Daemon)
- Server defines endpoints
- Daemon implements client methods
- Daemon must match server exactly

### Dependencies (Bidirectional)
- Shared dependencies must align
- Server updates may require daemon updates
- Critical deps (OpenAI SDK) must match major versions

### Versions (Server → Daemon)
- Server version is source of truth
- Daemon version should match
- Use `sync-version` to align

### Environment Variables (Server → Daemon)
- Server defines defaults
- Daemon should follow server defaults
- Shared variables must match

## 🛠️ Workflow

### Working on Server (Source of Truth)

```bash
# 1. Make changes to server
# ... edit src/routes/api-*.ts ...

# 2. Check what daemon needs
npm run sync:check

# 3. System will show:
#    🔴 SERVER has new endpoint, DAEMON needs update
#    💡 Add request_new_endpoint() to backend_client.py

# 4. Update daemon to follow server
# ... edit daemon-python/arcanos/backend_client.py ...

# 5. Verify sync
npm run sync:check
```

### Working on Daemon (Extension)

```bash
# 1. Make changes to daemon
# ... edit daemon-python/arcanos/backend_client.py ...

# 2. Check if it matches server
npm run sync:check

# 3. System will warn if:
#    ⚠️  Daemon method doesn't match server route
#    ⚠️  Daemon using fields server doesn't provide

# 4. Fix to match server (source of truth)
# ... update to match server ...

# 5. Verify sync
npm run sync:check
```

## 🎯 Sync System Features

### Server Change Detection
- Scans server routes for changes
- Identifies new endpoints
- Detects schema modifications
- Flags breaking changes

### Daemon Update Suggestions
- Specific method names to add
- Exact field mappings
- Code examples when possible
- Priority: HIGH (must fix)

### Priority System
1. **CRITICAL**: Server changes requiring daemon updates
2. **ERROR**: Daemon missing server endpoints
3. **WARNING**: Version/environment mismatches
4. **INFO**: Suggestions for alignment

## 📝 Examples

### Example 1: Server Adds New Endpoint

**Server Change:**
```typescript
// src/routes/api-new-feature.ts
router.post('/api/new-feature', ...)
```

**Sync System Detects:**
```
🔴 SERVER (source of truth) defines /api/new-feature
   DAEMON (extension) is missing 'request_new_feature()'
💡 Add request_new_feature() method to backend_client.py
```

**Action Required:**
- Update daemon to implement `request_new_feature()`
- Match server's request/response schema

### Example 2: Server Changes Schema

**Server Change:**
```typescript
// Server now requires 'priority' field
request: { message: string, priority: number }
```

**Sync System Detects:**
```
🔴 SERVER (source of truth) requires 'priority' field
   DAEMON (extension) method missing 'priority' parameter
💡 Update request_chat_completion() to include priority
```

**Action Required:**
- Update daemon method to include `priority`
- Ensure daemon matches server contract

### Example 3: Daemon Tries to Use Non-Existent Field

**Daemon Change:**
```python
# Daemon tries to use 'customField' that server doesn't provide
response.get('customField')  # Server doesn't return this
```

**Sync System Detects:**
```
⚠️  DAEMON (extension) uses 'customField'
    SERVER (source of truth) doesn't provide this field
💡 Remove customField usage or request server to add it
```

**Action Required:**
- Remove daemon's use of non-existent field
- Or request server feature (server is source of truth)

## ✅ Benefits

1. **Clear Hierarchy** - Server is source of truth
2. **Automatic Detection** - System finds what needs updating
3. **Specific Fixes** - Exact suggestions, not vague warnings
4. **Priority System** - Know what's critical vs nice-to-have
5. **Prevents Drift** - Daemon can't diverge from server
6. **Solo Dev Friendly** - System "has your back"

## 🎁 For Solo Developers

The sync system acts as your "backup" - when you work on the server (source of truth), it automatically:
- ✅ Detects what daemon needs updating
- ✅ Provides specific fix suggestions
- ✅ Prioritizes critical updates
- ✅ Ensures daemon follows server

**You focus on server changes, system handles daemon updates!**

---

**Remember**: Server defines, daemon follows. The sync system ensures daemon always matches server.
