#!/usr/bin/env node

// Comprehensive validation test for the database connection implementation
const http = require('http');
const fs = require('fs');
const path = require('path');

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          const parsedBody = method === 'GET' && path === '/' ? body : JSON.parse(body);
          resolve({
            statusCode: res.statusCode,
            body: parsedBody,
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            body: body,
          });
        }
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function validateImplementation() {
  console.log('🔍 Comprehensive Database Implementation Validation\n');

  const results = {
    codeImplementation: false,
    memoryTableStructure: false,
    gracefulFallback: false,
    apiEndpoints: false,
    errorHandling: false,
    tsIntegration: false
  };

  try {
    // 1. Validate code implementation matches problem statement
    console.log('1. Validating Database Connection Code Implementation');
    
    // Check JavaScript version
    const jsPath = path.join(__dirname, 'services', 'database-connection.js');
    const jsContent = fs.readFileSync(jsPath, 'utf8');
    
    const requiredElements = [
      'const { Pool } = require(\'pg\')',
      'const DATABASE_URL = process.env.DATABASE_URL',
      'CREATE TABLE IF NOT EXISTS memory',
      'key TEXT PRIMARY KEY',
      'value JSONB NOT NULL',
      'Connected to PostgreSQL and ensured memory table',
      'module.exports = pool'
    ];
    
    let jsImplementationValid = true;
    for (const element of requiredElements) {
      if (!jsContent.includes(element)) {
        console.log(`   ❌ Missing required element: ${element}`);
        jsImplementationValid = false;
      }
    }
    
    if (jsImplementationValid) {
      console.log('   ✅ JavaScript implementation matches problem statement');
      results.codeImplementation = true;
    }
    
    // Check TypeScript version
    const tsPath = path.join(__dirname, 'src', 'services', 'database-connection.ts');
    const tsContent = fs.readFileSync(tsPath, 'utf8');
    
    if (tsContent.includes('import { Pool } from \'pg\'') && 
        tsContent.includes('export default pool')) {
      console.log('   ✅ TypeScript implementation available');
      results.tsIntegration = true;
    }
    console.log('');

    // 2. Validate memory table structure
    console.log('2. Validating Memory Table Structure');
    if (jsContent.includes('key TEXT PRIMARY KEY') && 
        jsContent.includes('value JSONB NOT NULL')) {
      console.log('   ✅ Memory table structure matches specification');
      results.memoryTableStructure = true;
    } else {
      console.log('   ❌ Memory table structure incorrect');
    }
    console.log('');

    // 3. Test graceful fallback behavior
    console.log('3. Testing Graceful Fallback Behavior');
    const healthResponse = await makeRequest('GET', '/memory/health');
    
    if (healthResponse.statusCode === 503 && 
        healthResponse.body.database === false &&
        healthResponse.body.service === 'arcanos-memory') {
      console.log('   ✅ Graceful fallback working correctly');
      results.gracefulFallback = true;
    } else {
      console.log('   ❌ Fallback behavior incorrect');
      console.log('   Response:', healthResponse);
    }
    console.log('');

    // 4. Test API endpoints
    console.log('4. Testing Memory API Endpoints');
    
    // Test save endpoint validation
    const saveTest = await makeRequest('POST', '/memory/save', { value: 'missing key' });
    if (saveTest.statusCode === 400 && saveTest.body.error === 'key is required') {
      console.log('   ✅ Save endpoint validation working');
      results.apiEndpoints = true;
    } else {
      console.log('   ❌ Save endpoint validation failed');
    }
    console.log('');

    // 5. Test error handling
    console.log('5. Testing Error Handling');
    
    const loadTest = await makeRequest('GET', '/memory/load?key=test');
    if (loadTest.statusCode === 500 && 
        loadTest.body.details && 
        loadTest.body.details.includes('Database not configured')) {
      console.log('   ✅ Error handling working correctly');
      results.errorHandling = true;
    } else {
      console.log('   ❌ Error handling not working as expected');
    }
    console.log('');

    // Summary
    console.log('📊 Validation Summary:');
    const passedTests = Object.values(results).filter(r => r).length;
    const totalTests = Object.keys(results).length;
    
    for (const [test, passed] of Object.entries(results)) {
      console.log(`   ${passed ? '✅' : '❌'} ${test.replace(/([A-Z])/g, ' $1').toLowerCase()}`);
    }
    
    console.log(`\n🎯 Overall Score: ${passedTests}/${totalTests} tests passed`);
    
    if (passedTests === totalTests) {
      console.log('🎉 Implementation fully validated and meets all requirements!');
      
      console.log('\n📝 Implementation Details:');
      console.log('   - PostgreSQL connection pool created ✅');
      console.log('   - Memory table with correct schema ✅');
      console.log('   - Graceful fallback for missing DATABASE_URL ✅');
      console.log('   - RESTful API endpoints ✅');
      console.log('   - Error handling and validation ✅');
      console.log('   - TypeScript integration ✅');
      
      console.log('\n🚀 Next Steps:');
      console.log('   1. Set DATABASE_URL environment variable for production');
      console.log('   2. Test with real PostgreSQL database');
      console.log('   3. Monitor memory service health endpoint');
      
    } else {
      console.log('⚠️  Some validation tests failed. Review implementation.');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('❌ Validation failed:', error.message);
    process.exit(1);
  }
}

// Run validation
validateImplementation();