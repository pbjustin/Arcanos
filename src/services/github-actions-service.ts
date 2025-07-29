import axios from 'axios';
import { config } from '../config';

interface GitHubActionTrigger {
  repo: string; // Format: "owner/repo"
  workflow: string; // Workflow filename or ID
  ref: string; // Branch, tag, or commit SHA
  inputs?: Record<string, string>;
}

interface GitHubAPIConfig {
  token?: string;
  baseURL: string;
}

export class GitHubActionsService {
  private apiConfig: GitHubAPIConfig;

  constructor() {
    this.apiConfig = {
      token: process.env.GITHUB_TOKEN || process.env.GITHUB_API_TOKEN,
      baseURL: 'https://api.github.com'
    };
  }

  /**
   * Execute a GitHub Action workflow
   */
  async executeGitHubAction(trigger: GitHubActionTrigger): Promise<void> {
    if (!this.apiConfig.token) {
      console.warn('[GITHUB-ACTIONS] No GitHub token configured, skipping action trigger');
      return;
    }

    try {
      const [owner, repo] = trigger.repo.split('/');
      
      const response = await axios.post(
        `${this.apiConfig.baseURL}/repos/${owner}/${repo}/actions/workflows/${trigger.workflow}/dispatches`,
        {
          ref: trigger.ref,
          inputs: trigger.inputs || {}
        },
        {
          headers: {
            'Authorization': `Bearer ${this.apiConfig.token}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json'
          }
        }
      );

      console.log(`[GITHUB-ACTIONS] Successfully triggered workflow ${trigger.workflow} on ${trigger.repo}`);
      
    } catch (error: any) {
      console.error(`[GITHUB-ACTIONS] Failed to trigger workflow ${trigger.workflow}:`, {
        repo: trigger.repo,
        workflow: trigger.workflow,
        ref: trigger.ref,
        error: error.response?.data || error.message
      });
      throw error;
    }
  }

  /**
   * Get GitHub repository information
   */
  async getRepositoryInfo(repo: string): Promise<any> {
    if (!this.apiConfig.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const [owner, repoName] = repo.split('/');
      
      const response = await axios.get(
        `${this.apiConfig.baseURL}/repos/${owner}/${repoName}`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiConfig.token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      return response.data;
    } catch (error: any) {
      console.error(`[GITHUB-ACTIONS] Failed to get repository info for ${repo}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * List GitHub Action workflows for a repository
   */
  async listWorkflows(repo: string): Promise<any[]> {
    if (!this.apiConfig.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const [owner, repoName] = repo.split('/');
      
      const response = await axios.get(
        `${this.apiConfig.baseURL}/repos/${owner}/${repoName}/actions/workflows`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiConfig.token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      return response.data.workflows || [];
    } catch (error: any) {
      console.error(`[GITHUB-ACTIONS] Failed to list workflows for ${repo}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Get workflow run status
   */
  async getWorkflowRuns(repo: string, workflowId: string, limit: number = 10): Promise<any[]> {
    if (!this.apiConfig.token) {
      throw new Error('GitHub token not configured');
    }

    try {
      const [owner, repoName] = repo.split('/');
      
      const response = await axios.get(
        `${this.apiConfig.baseURL}/repos/${owner}/${repoName}/actions/workflows/${workflowId}/runs`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiConfig.token}`,
            'Accept': 'application/vnd.github.v3+json'
          },
          params: {
            per_page: limit
          }
        }
      );

      return response.data.workflow_runs || [];
    } catch (error: any) {
      console.error(`[GITHUB-ACTIONS] Failed to get workflow runs for ${repo}/${workflowId}:`, error.response?.data || error.message);
      throw error;
    }
  }

  /**
   * Check if the service has proper GitHub API access
   */
  async validateAccess(): Promise<boolean> {
    if (!this.apiConfig.token) {
      return false;
    }

    try {
      const response = await axios.get(
        `${this.apiConfig.baseURL}/user`,
        {
          headers: {
            'Authorization': `Bearer ${this.apiConfig.token}`,
            'Accept': 'application/vnd.github.v3+json'
          }
        }
      );

      console.log(`[GITHUB-ACTIONS] API access validated for user: ${response.data.login}`);
      return true;
    } catch (error: any) {
      console.error('[GITHUB-ACTIONS] API access validation failed:', error.response?.data || error.message);
      return false;
    }
  }
}

export const githubActionsService = new GitHubActionsService();

// Export convenience function
export const executeGitHubAction = (trigger: GitHubActionTrigger) => 
  githubActionsService.executeGitHubAction(trigger);