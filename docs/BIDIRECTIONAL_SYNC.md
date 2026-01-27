# Bidirectional Cross-Codebase Sync

## Overview

The ARCANOS sync system works **bidirectionally** - it checks alignment no matter which codebase you're working on.

## 🔄 Two-Way Checking

### 1. Server → Daemon (Primary Direction)
**When:** You work on TypeScript server  
**Checks:** What daemon needs to update to follow server  
**Priority:** HIGH (daemon must follow server)

**Example:**
```
You add: src/routes/api-new-feature.ts
System detects: Daemon needs request_new_feature() method
Action: Update daemon to match server
```

### 2. Daemon → Server (Validation Direction)
**When:** You work on Python daemon  
**Checks:** If daemon matches server (source of truth)  
**Priority:** MEDIUM (warnings if daemon diverges)

**Example:**
```
You add: daemon-python/arcanos/backend_client.py::request_new_method()
System detects: Server doesn't have corresponding route
Action: Either add route to server, or remove method from daemon
```

## 🎯 How It Works

### Working on Server

```bash
# 1. Make changes to server
# ... edit src/routes/api-*.ts ...

# 2. Run sync check
npm run sync:check

# 3. System shows:
🔴 SERVER (source of truth) defines /api/new-endpoint
   DAEMON (extension) is missing 'request_new_endpoint()'
💡 Add request_new_endpoint() method to backend_client.py

# 4. Update daemon to follow server
# ... edit daemon-python/arcanos/backend_client.py ...

# 5. Verify
npm run sync:check
```

### Working on Daemon

```bash
# 1. Make changes to daemon
# ... edit daemon-python/arcanos/backend_client.py ...

# 2. Run sync check
npm run sync:check

# 3. System shows:
⚠️  DAEMON has method 'request_new_feature()' 
    but SERVER (source of truth) doesn't have route /api/new-feature
💡 Either: 1) Add /api/new-feature route to server, 
            or 2) Remove request_new_feature() from daemon

# 4. Fix based on your needs:
#    Option A: Add route to server (if feature is needed)
#    Option B: Remove method from daemon (if not needed)

# 5. Verify
npm run sync:check
```

## 📊 What Gets Checked (Both Directions)

### Server → Daemon Checks
- ✅ New server endpoints → daemon needs methods
- ✅ Changed request schemas → daemon needs updates
- ✅ Changed response schemas → daemon needs updates
- ✅ New required fields → daemon must include
- ✅ Removed fields → daemon must remove

### Daemon → Server Checks
- ✅ Daemon methods → server has corresponding routes
- ✅ Daemon request fields → server accepts them
- ✅ Daemon response parsing → server returns those fields
- ✅ Daemon using non-existent endpoints → warning
- ✅ Daemon expecting fields server doesn't return → warning

## 🎯 Priority System

### HIGH Priority (Errors)
- **Server → Daemon**: Server changes requiring daemon updates
- **Action**: Must fix - daemon must follow server

### MEDIUM Priority (Warnings)
- **Daemon → Server**: Daemon diverging from server
- **Action**: Should fix - daemon should match server

### LOW Priority (Info)
- **Suggestions**: Optional improvements
- **Action**: Consider fixing

## 💡 Decision Making

### When Daemon → Server Warning Appears

**Scenario:** Daemon has method but server doesn't have route

**Options:**
1. **Add to Server** (if feature is needed)
   - Add route to `src/routes/api-*.ts`
   - Server becomes source of truth
   - Daemon now matches server ✅

2. **Remove from Daemon** (if feature not needed)
   - Remove method from `backend_client.py`
   - Daemon matches server ✅

**Recommendation:** Since server is source of truth, usually Option 2 (remove from daemon) unless you're intentionally adding a new feature that needs server support.

## 🔄 Complete Workflow

### Adding New Feature (Server First)

```bash
# 1. Add route to server (source of truth)
# ... edit src/routes/api-new-feature.ts ...

# 2. Check sync
npm run sync:check
# Shows: Daemon needs request_new_feature() method

# 3. Add method to daemon
# ... edit daemon-python/arcanos/backend_client.py ...

# 4. Verify
npm run sync:check
# Shows: ✅ Everything aligned
```

### Adding New Feature (Daemon First - Not Recommended)

```bash
# 1. Add method to daemon
# ... edit daemon-python/arcanos/backend_client.py ...

# 2. Check sync
npm run sync:check
# Shows: ⚠️ Daemon has method but server doesn't have route

# 3. Add route to server (source of truth)
# ... edit src/routes/api-new-feature.ts ...

# 4. Verify
npm run sync:check
# Shows: ✅ Everything aligned
```

## ✅ Benefits of Bidirectional Checking

1. **Catches Divergence Early** - Know when daemon doesn't match server
2. **Works Both Ways** - No matter which codebase you edit
3. **Clear Guidance** - Specific suggestions for both directions
4. **Prevents Drift** - Can't accidentally diverge
5. **Flexible** - Choose to add to server or remove from daemon

## 🎁 Summary

**The system has your back no matter which codebase you work on:**

- **Working on Server?** → System tells you what daemon needs
- **Working on Daemon?** → System tells you if it matches server

**Both directions are checked automatically!** 🚀
