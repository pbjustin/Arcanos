# GitHub Sync Setup Guide

This guide helps you configure the GitHub Sync functionality for automated CI/CD.

## 🔧 Required Configuration

### Step 1: GitHub Repository Secrets

Add these secrets in your GitHub repository settings (`Settings` → `Secrets and variables` → `Actions`):

#### Required Secrets for Railway Deployment

```
RAILWAY_TOKEN
```
- **Description**: Your Railway API token
- **How to get**: 
  1. Visit [Railway Dashboard](https://railway.app/dashboard)
  2. Go to Account Settings → Tokens
  3. Generate a new token
  4. Copy the token value

```
RAILWAY_SERVICE_ID  
```
- **Description**: Your Railway service ID
- **How to get**:
  1. Open your Railway project
  2. Go to your service settings
  3. Copy the Service ID from the URL or settings

```
RAILWAY_DOMAIN
```
- **Description**: Your Railway application domain
- **Example**: `https://yourapp-production-1234.up.railway.app`
- **How to get**:
  1. Deploy your app to Railway
  2. Copy the generated domain from Railway dashboard

### Step 2: Verify Workflow Permissions

Ensure GitHub Actions has the necessary permissions:

1. Go to `Settings` → `Actions` → `General`
2. Under "Workflow permissions", select:
   - ✅ "Read and write permissions"
   - ✅ "Allow GitHub Actions to create and approve pull requests"

### Step 3: Enable Workflow Triggers

The workflows are configured with these triggers:

- **CI**: Runs on every pull request and push to main
- **Deploy**: Runs on push to main (automatic) and manual dispatch
- **Quality**: Runs on PRs, pushes, and weekly schedule
- **Test**: Runs on PRs and pushes to main
- **Dependencies**: Runs weekly on Monday mornings
- **Monitoring**: Runs hourly to check application health

## 🚀 Quick Setup Verification

### Test the Setup

1. **Create a test branch:**
   ```bash
   git checkout -b test-github-sync
   echo "console.log('GitHub Sync test');" >> src/test.ts
   git add .
   git commit -m "test: GitHub Sync functionality"
   git push origin test-github-sync
   ```

2. **Create a pull request:**
   - The CI workflow should automatically run
   - Check the "Actions" tab to see workflow status

3. **Merge to main:**
   - After merging, the deploy workflow should run
   - Check Railway for successful deployment

### Expected Workflow Status

After setup, you should see these workflows in the Actions tab:

- ✅ **CI** - Building and testing code
- ✅ **Deploy to Railway** - Deploying to production
- ✅ **Code Quality & Security** - Scanning for issues
- ✅ **Test Suite** - Running comprehensive tests
- ✅ **Dependency Management** - Managing dependencies
- ✅ **Health & Monitoring** - Monitoring production

## 🔍 Troubleshooting

### Common Issues

#### ❌ "RAILWAY_TOKEN not found"
**Solution**: Add the Railway token to GitHub secrets as described in Step 1.

#### ❌ "Permission denied when creating PR"
**Solution**: Enable PR creation permissions in Step 2.

#### ❌ "Health check failed"
**Solution**: 
- Verify RAILWAY_DOMAIN is correct
- Ensure your Railway app is deployed and running
- Check Railway logs for application errors

#### ❌ "Build fails with missing dependencies"
**Solution**: 
- Run `npm install` locally to verify dependencies
- Ensure package.json includes all required dependencies
- Check for TypeScript compilation errors

### Workflow Debugging

#### View Workflow Logs
1. Go to "Actions" tab in your repository
2. Click on the failed workflow run
3. Click on the failed job to see detailed logs

#### Manual Workflow Trigger
```bash
# Trigger manual deployment
gh workflow run deploy.yml

# Trigger manual health check
gh workflow run monitoring.yml
```

#### Local Testing
```bash
# Test build locally
npm ci
npm run build
npm start

# Test health endpoint
curl http://localhost:8080/health
```

## 📋 Maintenance

### Weekly Tasks (Automated)
- **Dependency Updates**: Automated PR creation for security updates
- **Security Scanning**: Comprehensive vulnerability assessment
- **Health Monitoring**: Continuous uptime verification

### Monthly Tasks (Manual)
- Review and merge dependency update PRs
- Check workflow performance and optimization opportunities
- Review security audit reports

### Quarterly Tasks (Manual)
- Update workflow configurations for new features
- Review and update Node.js versions in CI matrix
- Optimize build and deployment performance

## 🎯 Success Metrics

Your GitHub Sync is working correctly when:

- ✅ All workflow badges show "passing" status
- ✅ PRs automatically trigger CI workflows
- ✅ Main branch pushes automatically deploy to Railway
- ✅ Security updates are proposed via automated PRs
- ✅ Health monitoring reports successful checks
- ✅ Application is accessible via Railway domain

## 📚 Additional Resources

- [GitHub Actions Documentation](https://docs.github.com/en/actions)
- [Railway Documentation](https://docs.railway.app/)
- [GitHub Secrets Management](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Workflow Syntax Reference](https://docs.github.com/en/actions/using-workflows/workflow-syntax-for-github-actions)

---

*For additional support, check the workflow logs in the Actions tab or refer to the troubleshooting section above.*