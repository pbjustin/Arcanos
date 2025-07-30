// Diagnostics: Verify GitHub Token and Repo Access
// Usage: node scripts/verify-github-access.js [owner/repo]
// The script checks whether the provided GitHub token can access the repository.

const repo = process.argv[2] || 'pbjustin/Arcanos';
const token = process.env.GITHUB_TOKEN;

async function verifyAccess() {
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'AI-Diagnostics'
      }
    });

    if (response.ok) {
      const info = await response.json();
      console.log('✅ GitHub access verified:', info.full_name);
    } else {
      console.error(`❌ GitHub token failed: ${response.status} - ${response.statusText}`);
      const text = await response.text();
      console.error('Response:', text);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('❌ GitHub access check error:', err.message);
    process.exitCode = 1;
  }
}

verifyAccess();
