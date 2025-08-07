import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';

const router = express.Router();
const execAsync = promisify(exec);

// Repo sync module - handles GitHub repository synchronization
router.post('/repo/sync', async (req, res) => {
  try {
    console.log('[🔄 REPO SYNC] Starting repository synchronization...');
    
    const syncResult = {
      status: 'success',
      message: 'Repository sync completed',
      timestamp: new Date().toISOString(),
      operations: []
    };

    // Check if we're in a git repository
    try {
      const { stdout: gitStatus } = await execAsync('git status --porcelain');
      syncResult.operations.push({
        operation: 'git_status_check',
        status: 'success',
        message: 'Git repository detected'
      });

      // Check for uncommitted changes
      if (gitStatus.trim()) {
        syncResult.operations.push({
          operation: 'uncommitted_changes',
          status: 'warning',
          message: `Found ${gitStatus.split('\n').length} uncommitted changes`
        });
      }
    } catch (error) {
      syncResult.operations.push({
        operation: 'git_status_check',
        status: 'error',
        message: 'Not a git repository or git not available'
      });
    }

    // Fetch latest changes
    try {
      const { stdout: fetchResult } = await execAsync('git fetch origin');
      syncResult.operations.push({
        operation: 'git_fetch',
        status: 'success',
        message: 'Fetched latest changes from remote'
      });
    } catch (error) {
      syncResult.operations.push({
        operation: 'git_fetch',
        status: 'error',
        message: `Failed to fetch: ${error.message}`
      });
    }

    // Get current branch info
    try {
      const { stdout: branchInfo } = await execAsync('git branch --show-current');
      const currentBranch = branchInfo.trim();
      
      syncResult.operations.push({
        operation: 'branch_info',
        status: 'success',
        message: `Current branch: ${currentBranch}`
      });

      // Check if we can pull changes
      try {
        const { stdout: pullResult } = await execAsync(`git pull origin ${currentBranch}`);
        syncResult.operations.push({
          operation: 'git_pull',
          status: 'success',
          message: pullResult.trim() || 'Repository is up to date'
        });
      } catch (error) {
        syncResult.operations.push({
          operation: 'git_pull',
          status: 'error',
          message: `Failed to pull: ${error.message}`
        });
      }
    } catch (error) {
      syncResult.operations.push({
        operation: 'branch_info',
        status: 'error',
        message: `Failed to get branch info: ${error.message}`
      });
    }

    // Get latest commit info
    try {
      const { stdout: commitInfo } = await execAsync('git log -1 --pretty=format:"%H %s %an %ad" --date=short');
      syncResult.operations.push({
        operation: 'latest_commit',
        status: 'success',
        message: commitInfo.trim()
      });
    } catch (error) {
      syncResult.operations.push({
        operation: 'latest_commit',
        status: 'error',
        message: `Failed to get commit info: ${error.message}`
      });
    }

    // Check if sync was successful overall
    const hasErrors = syncResult.operations.some(op => op.status === 'error');
    if (hasErrors) {
      syncResult.status = 'partial';
      syncResult.message = 'Repository sync completed with some errors';
    }

    console.log(`[🔄 REPO SYNC] Sync completed with status: ${syncResult.status}`);
    res.json(syncResult);
  } catch (error) {
    console.error('[🔄 REPO SYNC] Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Repository sync failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Repo status endpoint
router.get('/repo/status', async (req, res) => {
  try {
    const statusResult = {
      status: 'success',
      message: 'Repository status retrieved',
      timestamp: new Date().toISOString(),
      repository: {}
    };

    // Get git remote info
    try {
      const { stdout: remoteUrl } = await execAsync('git remote get-url origin');
      statusResult.repository.remote = remoteUrl.trim();
    } catch (error) {
      statusResult.repository.remote = 'Not available';
    }

    // Get current branch
    try {
      const { stdout: branch } = await execAsync('git branch --show-current');
      statusResult.repository.branch = branch.trim();
    } catch (error) {
      statusResult.repository.branch = 'Not available';
    }

    // Get last commit
    try {
      const { stdout: lastCommit } = await execAsync('git log -1 --pretty=format:"%H %s %an %ad" --date=short');
      statusResult.repository.lastCommit = lastCommit.trim();
    } catch (error) {
      statusResult.repository.lastCommit = 'Not available';
    }

    res.json(statusResult);
  } catch (error) {
    console.error('[🔄 REPO STATUS] Error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get repository status',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Repo module status
router.get('/repo/sync/status', (req, res) => {
  res.json({
    module: 'repo',
    status: 'active',
    version: '1.0.0',
    endpoints: ['/repo/sync', '/repo/status', '/repo/sync/status']
  });
});

export default router;