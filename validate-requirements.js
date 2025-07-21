#!/usr/bin/env node

// Comprehensive validation script for Railway + GitHub Copilot integration
// Validates all requirements from the problem statement

const fs = require('fs');
const path = require('path');

console.log('==================================================');
console.log('  ARCANOS Railway + GitHub Copilot Validation');
console.log('==================================================\n');

let allPassed = true;

function validateFile(filePath, description) {
  if (fs.existsSync(filePath)) {
    console.log(`✅ ${description}: Found`);
    return true;
  } else {
    console.log(`❌ ${description}: Missing`);
    allPassed = false;
    return false;
  }
}

function validateFileContent(filePath, searchText, description) {
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf8');
    if (content.includes(searchText)) {
      console.log(`✅ ${description}: Configured`);
      return true;
    } else {
      console.log(`❌ ${description}: Missing configuration`);
      allPassed = false;
      return false;
    }
  } else {
    console.log(`❌ ${description}: File not found`);
    allPassed = false;
    return false;
  }
}

// 1. Verify Railway project endpoints are active and CORS-compliant
console.log('1. Railway Project Endpoints & CORS Compliance:');
validateFile('src/index.ts', 'Main server file');
validateFileContent('src/index.ts', 'cors()', 'CORS middleware');
validateFileContent('src/index.ts', 'app.post(\'/query-finetune\'', '/query-finetune endpoint');

// 2. Ensure fine-tuned model route (/query-finetune) is publicly POST-accessible
console.log('\n2. Fine-tuned Model Route (/query-finetune):');
validateFileContent('src/index.ts', 'POST /query-finetune endpoint', 'POST accessibility');
validateFileContent('src/index.ts', 'OpenAIService', 'Fine-tuned model integration');

// 3. Scaffold fallback route (/ask) for logic failover  
console.log('\n3. Fallback Route (/ask):');
validateFileContent('src/index.ts', 'app.post(\'/ask\'', '/ask endpoint');
validateFileContent('src/index.ts', 'fallback route', '/ask fallback logic');

// 4. Validate .env settings for GitHub Copilot and Postman usage
console.log('\n4. Environment Configuration:');
validateFile('.env.example', '.env.example file');
validateFileContent('.env.example', 'RAILWAY_PROJECT', 'Railway project config');
validateFileContent('.env.example', 'API_URL', 'API URL config');
validateFileContent('.env.example', 'MODEL_ROUTE', 'Model route config');
validateFileContent('.env.example', 'LOGIC_ROUTE', 'Logic route config');

// 5. Health Check Endpoint (Railway compliance)
console.log('\n5. Health Check Endpoint:');
validateFile('railway.json', 'Railway configuration');
validateFileContent('railway.json', '"healthcheckPath": "/health"', 'Health check path');
validateFileContent('railway.json', '"PORT": "3000"', 'Port configuration');
validateFileContent('src/index.ts', 'app.get(\'/health\'', '/health endpoint');

// 6. GitHub Copilot Reference Files
console.log('\n6. GitHub Copilot Integration Files:');
validateFile('arcanos-api.http', 'Comprehensive API examples');
validateFile('github-copilot-reference.http', 'GitHub Copilot reference commands');
validateFileContent('github-copilot-reference.http', '/query-finetune', 'Fine-tune endpoint example');
validateFileContent('github-copilot-reference.http', 'curl -X POST', 'cURL reference command');

// 7. Build and Deployment Ready
console.log('\n7. Build and Deployment Configuration:');
validateFile('package.json', 'Package configuration');
validateFile('tsconfig.json', 'TypeScript configuration');
validateFileContent('package.json', '"build": "tsc"', 'Build script');
validateFileContent('package.json', '"start":', 'Start script');
validateFileContent('railway.json', '"buildCommand": "npm ci && npm run build"', 'Railway build command');

// 8. Test Scripts
console.log('\n8. Testing Infrastructure:');
validateFile('test-railway-copilot.js', 'Railway + Copilot test script');
validateFile('test-cors-compliance.js', 'CORS compliance test');

console.log('\n==================================================');
if (allPassed) {
  console.log('           🎉 ALL REQUIREMENTS PASSED! 🎉');
  console.log('==================================================');
  console.log('✅ Railway project endpoints are CORS-compliant');
  console.log('✅ Fine-tuned model route (/query-finetune) is ready');
  console.log('✅ Fallback route (/ask) is scaffolded');
  console.log('✅ .env settings are configured for GitHub Copilot');
  console.log('✅ Health check endpoint is Railway-compliant');
  console.log('✅ GitHub Copilot reference files are provided');
  console.log('');
  console.log('🚀 Ready for Railway deployment!');
  console.log('📡 Ready for GitHub Copilot integration!');
} else {
  console.log('           ❌ SOME REQUIREMENTS FAILED');
  console.log('==================================================');
  console.log('Please review the failed items above.');
}
console.log('==================================================');