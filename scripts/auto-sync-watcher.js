#!/usr/bin/env node

/**
 * ARCANOS Auto-Sync Watcher
 * Automatically runs sync checks when files change
 * Works with any coding agent (VS Code, Cursor, GitHub Copilot, etc.)
 */

import { watch, watchFile } from 'fs';
import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { generateSyncReport } from './cross-codebase-sync.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Paths to watch
const WATCH_PATHS = {
  server: [
    path.join(ROOT, 'src', 'routes'),
    path.join(ROOT, 'src', 'services'),
    path.join(ROOT, 'package.json')
  ],
  daemon: [
    path.join(ROOT, 'daemon-python'),
    path.join(ROOT, 'daemon-python', 'requirements.txt'),
    path.join(ROOT, 'daemon-python', 'arcanos', 'config.py')
  ]
};

// Debounce timer
let syncTimer = null;
const DEBOUNCE_MS = 2000; // Wait 2 seconds after last change

// Track what changed
let lastChange = {
  file: null,
  time: null,
  type: null // 'server' or 'daemon'
};

/**
 * Run sync check
 */
async function runSyncCheck(changedFile, changeType) {
  console.log(`\n🔄 Auto-sync triggered by ${changeType} change: ${path.relative(ROOT, changedFile)}\n`);
  
  try {
    const result = await generateSyncReport();
    
    if (!result.success) {
      console.log('\n⚠️  Sync issues detected. Review the output above.\n');
    } else {
      console.log('\n✅ Codebases are in sync!\n');
    }
  } catch (error) {
    console.error('❌ Sync check failed:', error.message);
  }
}

/**
 * Handle file change
 */
function handleFileChange(eventType, filename, changeType) {
  // Clear existing timer
  if (syncTimer) {
    clearTimeout(syncTimer);
  }
  
  // Update last change
  lastChange = {
    file: filename,
    time: Date.now(),
    type: changeType
  };
  
  // Debounce: wait for more changes
  syncTimer = setTimeout(() => {
    runSyncCheck(filename, changeType);
  }, DEBOUNCE_MS);
}

/**
 * Watch directory recursively (using watchFile for compatibility)
 */
async function watchDirectory(dirPath, changeType, onChange) {
  try {
    // Use watchFile for better cross-platform support
    const watcher = watchFile(dirPath, { interval: 1000 }, (curr, prev) => {
      if (curr.mtime !== prev.mtime) {
        onChange('change', dirPath, changeType);
      }
    });
    
    console.log(`👀 Watching ${changeType}: ${path.relative(ROOT, dirPath)}`);
    return watcher;
  } catch (error) {
    console.warn(`⚠️  Could not watch ${dirPath}: ${error.message}`);
    return null;
  }
}

/**
 * Start watching
 */
function startWatcher() {
  console.log('🚀 ARCANOS Auto-Sync Watcher Started\n');
  console.log('📋 Architecture: Server (source of truth) → Daemon (extension)\n');
  console.log('👀 Monitoring file changes...\n');
  console.log('='.repeat(60) + '\n');
  
  const watchers = [];
  
  // Watch server paths
  for (const serverPath of WATCH_PATHS.server) {
    try {
      const watcher = await watchDirectory(serverPath, 'server', handleFileChange);
      if (watcher) watchers.push(watcher);
    } catch (error) {
      // Path might not exist
    }
  }
  
  // Watch daemon paths
  for (const daemonPath of WATCH_PATHS.daemon) {
    if (typeof daemonPath === 'string') {
      try {
        const watcher = await watchDirectory(daemonPath, 'daemon', handleFileChange);
        if (watcher) watchers.push(watcher);
      } catch (error) {
        // Path might not exist
      }
    }
  }
  
  // Watch individual files
  const filesToWatch = [
    path.join(ROOT, 'package.json'),
    path.join(ROOT, 'daemon-python', 'requirements.txt'),
    path.join(ROOT, 'daemon-python', 'arcanos', 'config.py')
  ];
  
  for (const filePath of filesToWatch) {
    try {
      const watcher = watch(filePath, (eventType) => {
        const changeType = filePath.includes('daemon-python') ? 'daemon' : 'server';
        handleFileChange(eventType, filePath, changeType);
      });
      watchers.push(watcher);
    } catch (error) {
      // File might not exist yet
    }
  }
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\n🛑 Stopping watcher...');
    watchers.forEach(watcher => {
      if (watcher && typeof watcher.close === 'function') {
        watcher.close();
      } else if (watcher && typeof watcher.unwatchFile === 'function') {
        watcher.unwatchFile();
      }
    });
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    console.log('\n\n🛑 Stopping watcher...');
    watchers.forEach(watcher => {
      if (watcher && typeof watcher.close === 'function') {
        watcher.close();
      } else if (watcher && typeof watcher.unwatchFile === 'function') {
        watcher.unwatchFile();
      }
    });
    process.exit(0);
  });
  
  console.log(`✅ Watching ${watchers.length} paths\n`);
  console.log('Press Ctrl+C to stop\n');
}

// Start if run directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startWatcher();
}

export { startWatcher, runSyncCheck };
