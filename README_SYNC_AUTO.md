# 🚀 Automatic Sync for All Coding Agents

## Overview

The ARCANOS sync system runs **automatically** for any coding agent working on this workspace:
- ✅ VS Code / Cursor
- ✅ GitHub Copilot
- ✅ Any AI coding assistant
- ✅ Command-line tools
- ✅ Git operations

## 🎯 How It Works

### Automatic Triggers

The sync system runs automatically:

1. **Before Git Commits** (pre-commit hook)
   - Blocks commits with sync errors
   - Ensures codebases stay aligned

2. **After Git Merges** (post-merge hook)
   - Checks sync after pulling changes
   - Alerts if server/daemon need updates

3. **When VS Code Opens** (workspace task)
   - Runs sync check on folder open
   - Shows status immediately

4. **On File Changes** (file watcher)
   - Monitors server and daemon files
   - Runs sync check when files change
   - Debounced to avoid spam

5. **On File Save** (VS Code task)
   - Optional: runs on save
   - Configurable in VS Code settings

## ⚙️ Setup

### One-Time Setup

```bash
# Run setup (also runs automatically after npm install)
npm run sync:setup
```

This sets up:
- ✅ Git hooks (pre-commit, post-merge)
- ✅ VS Code tasks
- ✅ Workspace configuration
- ✅ File watchers

### Start File Watcher (Optional)

```bash
# Start continuous monitoring
npm run sync:auto
```

This watches for file changes and runs sync checks automatically.

## 📋 Configuration Files

### For VS Code / Cursor

- **`.vscode/tasks.json`** - Auto-runs sync on folder open
- **`.vscode/settings.json`** - Sync preferences
- **`.vscode/extensions.json`** - Recommended extensions

### For Git

- **`.git/hooks/pre-commit`** - Runs before commits
- **`.git/hooks/post-merge`** - Runs after merges

### For Any Agent

- **`.workspace/arcanos-sync.json`** - Workspace config
- **`.cursorrules`** - AI assistant rules

## 🎁 What Gets Checked Automatically

When any agent works on the workspace:

1. **Dependencies** - Version alignment
2. **API Contracts** - Server ↔ Daemon matching
3. **Versions** - Number synchronization
4. **Environment Variables** - Alignment
5. **Server Changes** - What daemon needs updating
6. **Breaking Changes** - Compatibility issues

## 🔧 Customization

### VS Code Settings

Edit `.vscode/settings.json`:

```json
{
  "arcanos.sync": {
    "autoCheck": true,
    "checkOnSave": true,
    "checkOnFileChange": true
  }
}
```

### Git Hooks

Edit `.git/hooks/pre-commit` or `.git/hooks/post-merge` to customize behavior.

### Workspace Config

Edit `.workspace/arcanos-sync.json` to change:
- Watch paths
- Auto-run triggers
- Command preferences

## 🚨 What Happens When Issues Are Found

### Pre-Commit Hook

```
🔍 Running cross-codebase sync check before commit...

⚠️  Synchronization Issues Found:
  🔴 SERVER has /api/new-endpoint, DAEMON needs update

❌ Sync check failed. Please fix issues before committing.
```

**Result**: Commit is blocked until issues are fixed.

### Post-Merge Hook

```
🔍 Running cross-codebase sync check after merge...

⚠️  Sync issues detected after merge. Review the output above.
```

**Result**: Warning shown, but merge completes.

### File Watcher

```
🔄 Auto-sync triggered by server change: src/routes/api-new.ts

⚠️  SERVER (source of truth) defines /api/new-endpoint
   DAEMON (extension) is missing 'request_new_endpoint()'
💡 Add request_new_endpoint() method to backend_client.py
```

**Result**: Notification shown, you can fix when ready.

## 📊 Status Indicators

- ✅ **Green checkmark** - Everything in sync
- ⚠️ **Yellow warning** - Issues found, should fix
- 🔴 **Red error** - Critical issues, must fix
- 💡 **Lightbulb** - Specific fix suggestion

## 🎯 For Different Agents

### VS Code / Cursor
- Tasks run automatically
- Settings apply automatically
- Extensions recommended

### GitHub Copilot / AI Assistants
- `.cursorrules` provides context
- Workspace config guides behavior
- Auto-suggestions based on sync rules

### Command Line
- Git hooks run automatically
- Manual commands available
- Scripts work anywhere

### CI/CD Pipelines
- Add `npm run sync:check` to pipeline
- Fails build on sync errors
- Ensures deployments are synced

## 🔄 Manual Override

If you need to skip automatic checks:

```bash
# Skip pre-commit hook (not recommended)
git commit --no-verify

# Run manual check
npm run sync:check

# Start watcher manually
npm run sync:auto
```

## 📚 Learn More

- **Quick Start**: `docs/QUICK_START_SYNC.md`
- **Full Guide**: `docs/CROSS_CODEBASE_SYNC.md`
- **Architecture**: `docs/ARCHITECTURE_SOURCE_OF_TRUTH.md`

---

**The sync system works automatically for any coding agent. No manual intervention needed!** 🎉
