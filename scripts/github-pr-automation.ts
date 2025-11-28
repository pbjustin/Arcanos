import { Octokit } from '@octokit/rest';
import dotenv from 'dotenv';
import OpenAI from 'openai';

dotenv.config();

const REPO_OWNER = 'pbjustin';
const REPO_NAME = 'Arcanos';
const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function requireEnv(name: string, value?: string): string {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const GITHUB_TOKEN = requireEnv('GITHUB_TOKEN', process.env.GITHUB_TOKEN);
const OPENAI_API_KEY = requireEnv('OPENAI_API_KEY', process.env.OPENAI_API_KEY);

const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function createBranch(branchName: string, baseBranch: string) {
  const { data: baseBranchData } = await octokit.repos.getBranch({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    branch: baseBranch
  });

  try {
    await octokit.git.createRef({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      ref: `refs/heads/${branchName}`,
      sha: baseBranchData.commit.sha
    });
    console.log(`Branch ${branchName} created from ${baseBranch}`);
  } catch (error: any) {
    if (error.status === 422) {
      console.log(`Branch ${branchName} already exists; reusing it.`);
      return;
    }
    throw error;
  }
}

async function pushFile(branchName: string, filePath: string, content: string, commitMessage: string) {
  const fileContent = Buffer.from(content, 'utf8').toString('base64');

  try {
    const { data: fileData } = await octokit.repos.getContent({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
      ref: `refs/heads/${branchName}`
    });

    if (!('sha' in fileData)) {
      throw new Error(`Unexpected response when fetching ${filePath}`);
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: REPO_OWNER,
      repo: REPO_NAME,
      path: filePath,
      message: commitMessage,
      content: fileContent,
      branch: branchName,
      sha: fileData.sha
    });
  } catch (error: any) {
    if (error.status === 404) {
      await octokit.repos.createOrUpdateFileContents({
        owner: REPO_OWNER,
        repo: REPO_NAME,
        path: filePath,
        message: commitMessage,
        content: fileContent,
        branch: branchName
      });
    } else {
      throw error;
    }
  }

  console.log(`File ${filePath} updated on branch ${branchName}`);
}

async function createPullRequest(branchName: string, title: string, body: string) {
  const { data: pullRequest } = await octokit.pulls.create({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    title,
    body,
    head: branchName,
    base: 'main'
  });

  console.log(`Pull request created: ${pullRequest.html_url}`);
}

async function generateCommitMessage(prompt: string): Promise<string> {
  const response = await openai.chat.completions.create({
    model: DEFAULT_MODEL,
    messages: [
      { role: 'system', content: 'You craft concise, conventional git commit messages.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 120,
    temperature: 0.4
  });

  const commitMessage = response.choices[0]?.message?.content?.trim();

  if (!commitMessage) {
    throw new Error('OpenAI did not return a commit message');
  }

  return commitMessage;
}

async function main() {
  const branchName = 'ai-generated-feature';
  const baseBranch = 'main';
  const filePath = 'example-feature.ts';
  const fileContent = "console.log('AI-generated TypeScript file for Arcanos repository');\n";

  const commitMessage = await generateCommitMessage(
    'Generate a commit message for adding an AI-generated feature file.'
  );

  await createBranch(branchName, baseBranch);
  await pushFile(branchName, filePath, fileContent, commitMessage);
  await createPullRequest(
    branchName,
    'Add AI-generated feature file',
    'This pull request adds an AI-generated file as an example for the Arcanos project.'
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Workflow failed:', error);
    process.exit(1);
  });
}
