import { Octokit } from "@octokit/rest";
import { writeMemory, getMemory } from "../services/memory.js";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

export async function pushFileWithStability({
  owner,
  repo,
  branch = "main",
  path,
  content,
  message,
  memoryKey = "/staging/github_push_draft"
}: {
  owner: string;
  repo: string;
  branch?: string;
  path: string;
  content: string;
  message: string;
  memoryKey?: string;
}) {
  const base64Content = Buffer.from(content).toString("base64");

  // Step 1: Save to memory for audit and fallback
  await writeMemory(memoryKey, content);

  try {
    const response = await octokit.repos.getContent({ owner, repo, path });
    const sha = Array.isArray(response.data) ? undefined : 'sha' in response.data ? response.data.sha : undefined;
    
    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: base64Content,
      sha,
      branch
    });
  } catch (err: any) {
    if (err.status === 404) {
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: base64Content,
        branch
      });
    } else {
      await writeMemory("/logs/github_push_error", JSON.stringify(err));
      throw new Error("GitHub push failed: " + err.message);
    }
  }

  // Step 2: Confirm creation
  const fileCheck = await octokit.repos.getContent({ owner, repo, path });
  const fileData = Array.isArray(fileCheck.data) ? undefined : fileCheck.data;
  
  if (!fileData || !('sha' in fileData) || !fileData.sha) {
    throw new Error("Push appears complete but file is not retrievable. Investigate branch/path.");
  }

  // Step 3: Flag success in memory
  await writeMemory("/flags/github_push_confirmed", {
    path,
    timestamp: new Date().toISOString(),
    sha: fileData.sha
  });

  return fileData;
}