/**
 * Git utilities for writing to repository
 * Uses existing GitHub integration for stable operations
 */

import { pushFileWithStability } from './githubPushStable';
import type { ReflectionSnapshot } from '../services/ai';

export interface WriteToRepoOptions {
  path: string;
  commitMessage: string;
  branch?: string;
  owner?: string;
  repo?: string;
}

/**
 * Write snapshot content to repository using existing GitHub utilities
 */
export async function writeToRepo(
  snapshot: ReflectionSnapshot,
  options: WriteToRepoOptions
): Promise<void> {
  const {
    path,
    commitMessage,
    branch = 'main',
    owner = process.env.GITHUB_OWNER || 'pbjustin',
    repo = process.env.GITHUB_REPO || 'Arcanos'
  } = options;

  // Only proceed if GitHub token is available
  if (!process.env.GITHUB_TOKEN) {
    console.warn('GitHub token not available, skipping repository write');
    return;
  }

  // Create file content from snapshot
  const content = JSON.stringify(snapshot, null, 2);
  
  // Generate filename with timestamp
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${snapshot.label}_${timestamp}.json`;
  const fullPath = `${path}${filename}`;

  try {
    await pushFileWithStability({
      owner,
      repo,
      branch,
      path: fullPath,
      content,
      message: commitMessage,
      memoryKey: `/staging/reflection_${snapshot.label}`
    });

    console.log(`Successfully wrote reflection to repository: ${fullPath}`);
  } catch (error: any) {
    console.error('Failed to write to repository:', error.message);
    // Don't throw - allow the system to continue even if GitHub write fails
  }
}