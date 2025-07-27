const axios = require('axios');

async function dispatchCommand(command, options) {
  if (command !== 'createPullRequest') {
    throw new Error(`Unknown command: ${command}`);
  }
  if (!options.repo) throw new Error('repo is required');
  const [owner, repo] = options.repo.split('/');
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN environment variable is required');
  }
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls`;
  const body = {
    title: options.title,
    head: options.branch,
    base: options.base || 'main',
    body: options.body,
    draft: !!options.draft
  };
  const headers = {
    'Authorization': `token ${token}`,
    'User-Agent': 'arcanos-script',
    'Accept': 'application/vnd.github+json'
  };
  const response = await axios.post(url, body, { headers });
  return response.data;
}

(async () => {
  try {
    const result = await dispatchCommand('createPullRequest', {
      repo: 'your-username/your-repo',
      branch: 'feature/diagnostic-refactor',
      title: '[DRAFT] Refactor: Modular Diagnostic Logic',
      body: 'This draft PR includes refactoring of the diagnostic system using modular handlers. Not ready for merge.',
      draft: true
    });
    console.log('Created PR:', result.html_url);
  } catch (err) {
    console.error('Failed to create PR:', err.message);
  }
})();
