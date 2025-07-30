import { config } from '../config';
import { askArcanosV1_Safe } from './arcanos-v1-interface';
import { executeGitHubAction } from './github-actions-service';
import { getUnifiedOpenAI } from './unified-openai';

const unifiedOpenAI = getUnifiedOpenAI();

interface GitHubPushPayload {
  repository: {
    full_name: string;
    clone_url: string;
  };
  commits: Array<{
    id: string;
    message: string;
    author: { name: string; email: string };
    added: string[];
    modified: string[];
    removed: string[];
  }>;
  head_commit: {
    id: string;
    message: string;
  };
  ref: string;
}

interface GitHubPRPayload {
  action: string;
  pull_request: {
    id: number;
    title: string;
    body: string;
    merged: boolean;
    merge_commit_sha: string;
    base: { ref: string };
    head: { ref: string };
  };
  repository: {
    full_name: string;
  };
}

interface GitHubReleasePayload {
  action: string;
  release?: {
    tag_name: string;
    name: string;
    body: string;
  };
  ref?: string;
  ref_type?: string;
  repository: {
    full_name: string;
  };
}

export class GitHubWebhookService {
  /**
   * Handle push events - trigger code analysis and potential actions
   */
  async handlePush(payload: GitHubPushPayload): Promise<void> {
    console.log(`[GITHUB-WEBHOOK] Processing push to ${payload.repository.full_name}`);
    
    try {
      // Analyze the changes with ARCANOS
      const commitMessages = payload.commits.map(c => c.message).join('\n');
      const modifiedFiles = payload.commits.flatMap(c => [...c.added, ...c.modified]);
      
      const analysisPrompt = `Analyze this code push:
Repository: ${payload.repository.full_name}
Branch: ${payload.ref}
Commits: ${commitMessages}
Modified files: ${modifiedFiles.join(', ')}

Determine if any automated actions should be triggered (testing, deployment, code review, etc.).`;

      const messages = [
        {
          role: 'system' as const,
          content: 'You are ARCANOS, an AI backend controller with code analysis capabilities. You specialize in code analysis, security review, and quality assessment. Provide detailed, actionable insights.'
        },
        {
          role: 'user' as const,
          content: analysisPrompt
        }
      ];

      const analysis = await unifiedOpenAI.chat(messages, {
        maxTokens: 1500,
        temperature: 0.3
      });
      console.log('[GITHUB-WEBHOOK] Push analysis completed (length: ' + analysis.content.length + ')');

      // Check if ARCANOS suggests triggering actions
      if (analysis.content.includes('trigger') || analysis.content.includes('deploy') || analysis.content.includes('test')) {
        await this.triggerCodeAnalysisAction(payload);
      }

    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Error handling push:', error);
    }
  }

  /**
   * Handle PR merged events - trigger deployment or integration actions
   */
  async handlePRMerged(payload: GitHubPRPayload): Promise<void> {
    console.log(`[GITHUB-WEBHOOK] Processing PR merge: #${payload.pull_request.id}`);
    
    try {
      const analysisPrompt = `PR merged:
Repository: ${payload.repository.full_name}
Title: ${payload.pull_request.title}
Description: ${payload.pull_request.body}
Base branch: ${payload.pull_request.base.ref}
Head branch: ${payload.pull_request.head.ref}

Determine if this merge should trigger deployment, integration tests, or other automated actions.`;

      const messages = [
        {
          role: 'system' as const,
          content: 'You are ARCANOS, an AI backend controller with deployment analysis capabilities. You analyze deployment readiness, infrastructure requirements, and release safety. Be thorough and cautious.'
        },
        {
          role: 'user' as const,
          content: analysisPrompt
        }
      ];

      const analysis = await unifiedOpenAI.chat(messages, {
        maxTokens: 1500,
        temperature: 0.3
      });
      console.log('[GITHUB-WEBHOOK] PR merge analysis completed (length: ' + analysis.content.length + ')');

      // Trigger deployment if this is a merge to main/master
      if (payload.pull_request.base.ref === 'main' || payload.pull_request.base.ref === 'master') {
        await this.triggerDeploymentAction(payload);
      }

    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Error handling PR merge:', error);
    }
  }

  /**
   * Handle tag/release events - trigger release actions
   */
  async handleTagRelease(payload: GitHubReleasePayload): Promise<void> {
    console.log(`[GITHUB-WEBHOOK] Processing tag/release: ${payload.release?.tag_name || payload.ref}`);
    
    try {
      const tagName = payload.release?.tag_name || payload.ref;
      const analysisPrompt = `Tag/Release created:
Repository: ${payload.repository.full_name}
Tag: ${tagName}
Release name: ${payload.release?.name || 'N/A'}
Release notes: ${payload.release?.body || 'N/A'}

Determine if this release should trigger production deployment, documentation updates, or other release-related actions.`;

      const messages = [
        {
          role: 'system' as const,
          content: 'You are ARCANOS, an AI backend controller with release analysis capabilities. You evaluate releases, generate documentation, and assess impact. Focus on clarity and completeness.'
        },
        {
          role: 'user' as const,
          content: analysisPrompt
        }
      ];

      const analysis = await unifiedOpenAI.chat(messages, {
        maxTokens: 2000,
        temperature: 0.3
      });
      console.log('[GITHUB-WEBHOOK] Release analysis completed (length: ' + analysis.content.length + ')');

      // Trigger release actions
      await this.triggerReleaseAction(payload);

    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Error handling tag/release:', error);
    }
  }

  /**
   * Trigger GitHub Actions for code analysis
   */
  private async triggerCodeAnalysisAction(payload: GitHubPushPayload): Promise<void> {
    try {
      await executeGitHubAction({
        repo: payload.repository.full_name,
        workflow: 'code-analysis.yml',
        ref: payload.ref,
        inputs: {
          commit_sha: payload.head_commit.id,
          trigger_source: 'arcanos_webhook'
        }
      });
      console.log('[GITHUB-WEBHOOK] Triggered code analysis action');
    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Failed to trigger code analysis action:', error);
    }
  }

  /**
   * Trigger GitHub Actions for deployment
   */
  private async triggerDeploymentAction(payload: GitHubPRPayload): Promise<void> {
    try {
      await executeGitHubAction({
        repo: payload.repository.full_name,
        workflow: 'deploy.yml',
        ref: payload.pull_request.base.ref,
        inputs: {
          pr_number: payload.pull_request.id.toString(),
          merge_commit_sha: payload.pull_request.merge_commit_sha,
          trigger_source: 'arcanos_webhook'
        }
      });
      console.log('[GITHUB-WEBHOOK] Triggered deployment action');
    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Failed to trigger deployment action:', error);
    }
  }

  /**
   * Trigger GitHub Actions for release
   */
  private async triggerReleaseAction(payload: GitHubReleasePayload): Promise<void> {
    try {
      await executeGitHubAction({
        repo: payload.repository.full_name,
        workflow: 'release.yml',
        ref: payload.release?.tag_name || payload.ref || 'main',
        inputs: {
          tag_name: payload.release?.tag_name || payload.ref || 'latest',
          trigger_source: 'arcanos_webhook'
        }
      });
      console.log('[GITHUB-WEBHOOK] Triggered release action');
    } catch (error) {
      console.error('[GITHUB-WEBHOOK] Failed to trigger release action:', error);
    }
  }
}

export const githubWebhookService = new GitHubWebhookService();