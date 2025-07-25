/**
 * Shared Test Utilities for ARCANOS Backend
 * Consolidates common test patterns to reduce duplication
 */

const axios = require('axios');
const http = require('http');

// Common test configuration
const TEST_CONFIG = {
  BASE_URL: process.env.TEST_URL || 'http://localhost:8080',
  LEGACY_PORT: process.env.TEST_PORT || 3000,
  TIMEOUT: 10000,
  AUTH_TOKEN: process.env.ARCANOS_API_TOKEN || 'test'
};

/**
 * Unified HTTP request function using axios (preferred)
 * @param {string} method - HTTP method
 * @param {string} endpoint - API endpoint (with or without leading slash)
 * @param {Object} options - Request options
 * @returns {Promise<Object>} - Response with status and data
 */
async function makeAxiosRequest(method, endpoint, options = {}) {
  const { data, headers = {}, timeout = TEST_CONFIG.TIMEOUT, includeAuth = false } = options;
  
  // Ensure endpoint starts with /
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  
  const config = {
    method,
    url: `${TEST_CONFIG.BASE_URL}${normalizedEndpoint}`,
    timeout,
    headers: {
      'Content-Type': 'application/json',
      ...headers
    }
  };

  // Add auth header if requested
  if (includeAuth) {
    config.headers.Authorization = `Bearer ${TEST_CONFIG.AUTH_TOKEN}`;
  }

  if (data) {
    config.data = data;
  }

  try {
    const response = await axios(config);
    return {
      success: true,
      status: response.status,
      data: response.data,
      headers: response.headers
    };
  } catch (error) {
    return {
      success: false,
      status: error.response?.status || 0,
      data: error.response?.data || null,
      error: error.message,
      headers: error.response?.headers || {}
    };
  }
}

/**
 * Legacy HTTP request function (for backwards compatibility)
 * @param {string} method - HTTP method
 * @param {string} path - API path
 * @param {Object} data - Request data
 * @returns {Promise<Object>} - Response with statusCode and body
 */
function makeLegacyRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: TEST_CONFIG.LEGACY_PORT,
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
          const parsedBody = JSON.parse(body);
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

/**
 * Common test result logger
 * @param {string} testName - Name of the test
 * @param {Object} result - Test result object
 * @param {boolean} verbose - Whether to show detailed output
 */
function logTestResult(testName, result, verbose = false) {
  const status = result.success ? '✅' : '❌';
  const statusCode = result.status || result.statusCode || 'N/A';
  
  console.log(`${status} ${testName}: ${statusCode}`);
  
  if (verbose || !result.success) {
    if (result.data || result.body) {
      const output = result.data || result.body;
      const displayData = typeof output === 'string' 
        ? output.substring(0, 100) + (output.length > 100 ? '...' : '')
        : JSON.stringify(output).substring(0, 100) + '...';
      console.log(`   Response: ${displayData}`);
    }
    
    if (result.error) {
      console.log(`   Error: ${result.error}`);
    }
  }
}

/**
 * Test runner for endpoint tests
 * @param {Array} tests - Array of test configurations
 * @param {Object} options - Runner options
 * @returns {Promise<Object>} - Test summary
 */
async function runEndpointTests(tests, options = {}) {
  const { verbose = false, stopOnFailure = false } = options;
  
  console.log(`🧪 Running ${tests.length} endpoint tests...\n`);
  
  let passed = 0;
  let failed = 0;
  const results = [];

  for (const test of tests) {
    try {
      console.log(`Testing ${test.name}...`);
      
      const result = await makeAxiosRequest(
        test.method,
        test.endpoint,
        {
          data: test.data,
          headers: test.headers,
          includeAuth: test.includeAuth,
          timeout: test.timeout
        }
      );
      
      logTestResult(test.name, result, verbose);
      
      if (result.success) {
        passed++;
      } else {
        failed++;
        if (stopOnFailure) {
          console.log('\n🛑 Stopping on first failure');
          break;
        }
      }
      
      results.push({ test: test.name, result });
      
    } catch (error) {
      console.log(`❌ ${test.name}: EXCEPTION - ${error.message}`);
      failed++;
      results.push({ test: test.name, result: { success: false, error: error.message } });
      
      if (stopOnFailure) {
        console.log('\n🛑 Stopping on first failure');
        break;
      }
    }
    
    console.log('');
  }

  const summary = {
    total: tests.length,
    passed,
    failed,
    results
  };

  console.log(`\n📊 Test Results: ${passed} passed, ${failed} failed`);
  
  return summary;
}

/**
 * Common authentication headers helper
 * @param {string} token - Optional override token
 * @returns {Object} - Headers object
 */
function getAuthHeaders(token = null) {
  return {
    Authorization: `Bearer ${token || TEST_CONFIG.AUTH_TOKEN}`
  };
}

/**
 * Memory endpoint helper
 * @param {string} endpoint - Memory endpoint path
 * @returns {string} - Full memory API URL
 */
function getMemoryEndpoint(endpoint = '') {
  const baseMemoryUrl = `${TEST_CONFIG.BASE_URL}/api/memory`;
  return endpoint ? `${baseMemoryUrl}/${endpoint.replace(/^\//, '')}` : baseMemoryUrl;
}

module.exports = {
  TEST_CONFIG,
  makeAxiosRequest,
  makeLegacyRequest,
  logTestResult,
  runEndpointTests,
  getAuthHeaders,
  getMemoryEndpoint
};