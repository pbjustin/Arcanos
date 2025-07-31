// PATCH: Inject PR Diagnostics Logger
// Logs PR push attempts, GitHub response status, and any failure codes

import fs from 'fs';
import path from 'path';
import { pushPRToGitHub } from './services/git';
import { buildPatchSet } from './services/ai-reflections';

(async () => {
  try {
    const patch = await buildPatchSet({ useMemory: true });
    const prResponse = await pushPRToGitHub(patch, 'main');

    const logEntry = {
      timestamp: new Date().toISOString(),
      status: '✅ PR Push Attempted',
      response: prResponse,
    };

    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }

    fs.writeFileSync(
      path.join(__dirname, 'logs', `pr-log-${Date.now()}.json`),
      JSON.stringify(logEntry, null, 2)
    );

    console.log('📦 PR Push Logged');
  } catch (error: any) {
    const errorLog = {
      timestamp: new Date().toISOString(),
      status: '❌ PR Push Failed',
      error: error.message,
      stack: error.stack,
    };

    if (!fs.existsSync('logs')) {
      fs.mkdirSync('logs');
    }

    fs.writeFileSync(
      path.join(__dirname, 'logs', `pr-error-${Date.now()}.json`),
      JSON.stringify(errorLog, null, 2)
    );

    console.error('❌ PR Logging Failed:', error.message);
  }
})();

