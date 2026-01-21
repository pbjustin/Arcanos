# ARCANOS Probot Integration

## Overview

This repository includes an ARCANOS-powered GitHub App (Probot) that automatically reviews pull requests and provides intelligent refactoring suggestions. When a pull request is opened, ARCANOS analyzes the code changes and posts review comments focused on:

- Removing bloated, outdated, or legacy code
- Improving clarity, performance, and modularity
- Modernizing syntax with idiomatic best practices

## Files

- `probot-app.js` - Main Probot application with ARCANOS review logic
- `probot-server.js` - Standalone server to run the Probot app
- Updated `package.json` with new scripts for running Probot

## Setup Instructions

### 1. Create a GitHub App

1. Go to GitHub Settings > Developer settings > GitHub Apps
2. Click "New GitHub App"
3. Fill in the required fields:
   - **App name**: "ARCANOS Refactor Assistant" (or your choice)
   - **Homepage URL**: Your repository or server URL
   - **Webhook URL**: `https://your-domain.com/webhooks` (where the Probot server runs)
   - **Webhook secret**: Generate a secure random string
4. Set permissions:
   - **Pull requests**: Read & Write
   - **Issues**: Write (for posting comments)
   - **Contents**: Read (for accessing file diffs)
5. Subscribe to events:
   - **Pull request**
6. Download the private key file

### 2. Configure Environment Variables

Add these variables to your `.env` file:

```bash
# OpenAI Configuration (required)
OPENAI_API_KEY=your-openai-api-key-here

# GitHub App Configuration (required for Probot)
APP_ID=your-github-app-id
WEBHOOK_SECRET=your-webhook-secret
PRIVATE_KEY_PATH=./private-key.pem
# OR alternatively:
# PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
```

### 3. Install the GitHub App

1. Go to your GitHub App settings
2. Click "Install App"
3. Choose the repositories where you want ARCANOS to provide reviews
4. Complete the installation

### 4. Run the Probot Server

Choose one of these options:

#### Option A: Run Probot alongside existing ARCANOS services
```bash
npm run start-with-probot
```

#### Option B: Run Probot standalone
```bash
npm run probot
```

#### Option C: Run existing services without Probot
```bash
npm start
```

## How It Works

1. When a pull request is opened, GitHub sends a webhook to the Probot server
2. ARCANOS fetches the file changes and diffs from the pull request
3. For each modified file (excluding new files), ARCANOS:
   - Analyzes the code diff using GPT-4
   - Generates refactoring suggestions using the ARCANOS persona
   - Posts a comment on the pull request with specific recommendations
4. The review focuses on modernization, performance, and code clarity

## Customization

You can modify the ARCANOS review behavior by editing `probot-app.js`:

- **Model**: Change `model: "gpt-4"` to use a different OpenAI model
- **Temperature**: Adjust `temperature: 0.3` for more/less creative responses
- **System prompt**: Modify the ARCANOS persona instructions
- **File filtering**: Change the conditions for which files to review

## Troubleshooting

### Common Issues

1. **"OpenAI API key missing"**: Ensure `OPENAI_API_KEY` is set in your environment
2. **"GitHub App not configured"**: Verify `APP_ID`, `WEBHOOK_SECRET`, and private key are correct
3. **"Webhook not received"**: Check that your webhook URL is accessible and the GitHub App is installed
4. **"Permission denied"**: Ensure the GitHub App has proper permissions for the repository

### Testing

You can test the setup by:

1. Creating a test pull request with some code changes
2. Checking the Probot server logs for webhook events
3. Verifying that ARCANOS comments appear on the pull request

### Logs

The Probot server will log webhook events and any errors to the console. Monitor these logs to ensure proper operation.

## Integration with Existing ARCANOS Services

This Probot integration runs alongside your existing ARCANOS backend services. The `start-with-probot` script runs:

- Main ARCANOS server (`server.cjs`)
- Cron jobs (`cron.cjs`) 
- Probot GitHub App (`probot-server.js`)

All services share the same environment configuration and can run independently if needed.