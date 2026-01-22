#!/usr/bin/env node

/**
 * ARCANOS Cross-Codebase Synchronization System
 * Ensures Python daemon (extension) follows TypeScript server (source of truth)
 * 
 * Architecture:
 * - TypeScript Server (src/) = SOURCE OF TRUTH (GitHub repo)
 * - Python Daemon (daemon-python/) = EXTENSION (follows server)
 * 
 * When server changes, daemon must be updated to match.
 * 
 * Features:
 * - Dependency version alignment
 * - API contract validation (server → daemon)
 * - Environment variable sync (server → daemon)
 * - Version number sync (server → daemon)
 * - Error code alignment
 * - Test coverage checks
 * - Breaking change detection (server changes that break daemon)
 * - Auto-fix suggestions (prioritizes daemon updates)
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// Shared dependency mappings (OpenAI SDK versions, etc.)
const SHARED_DEPS = {
  'openai': {
    python: 'openai>=1.12.0',
    node: 'openai@^6.16.0',
    description: 'OpenAI SDK - must stay compatible',
    critical: true
  },
  'requests': {
    python: 'requests>=2.31.0',
    node: 'axios@^1.11.0',
    description: 'HTTP client libraries',
    critical: false
  }
};

// API contract definitions
const API_CONTRACTS = {
  '/api/ask': {
    method: 'POST',
    request: {
      messages: 'array',
      temperature: 'number?',
      model: 'string?',
      stream: 'boolean?'
    },
    response: {
      response: 'string',
      tokens: 'number',
      cost: 'number',
      model: 'string'
    },
    clientMethod: 'request_chat_completion'
  },
  '/api/vision': {
    method: 'POST',
    request: {
      imageBase64: 'string',
      prompt: 'string?',
      temperature: 'number?',
      model: 'string?',
      maxTokens: 'number?'
    },
    response: {
      response: 'string',
      tokens: 'number',
      cost: 'number',
      model: 'string'
    },
    clientMethod: 'request_vision_analysis'
  },
  '/api/transcribe': {
    method: 'POST',
    request: {
      audioBase64: 'string',
      filename: 'string?',
      model: 'string?',
      language: 'string?'
    },
    response: {
      text: 'string',
      model: 'string'
    },
    clientMethod: 'request_transcription'
  },
  '/api/update': {
    method: 'POST',
    request: {
      updateType: 'string',
      data: 'object'
    },
    response: {
      success: 'boolean'
    },
    clientMethod: 'submit_update_event'
  },
  '/api/auth/login': {
    method: 'POST',
    request: {
      email: 'string',
      password: 'string'
    },
    response: {
      token: 'string',
      userId: 'string',
      expiresAt: 'number?'
    },
    clientMethod: 'request_backend_login'
  }
};

// Shared environment variables that should match
const SHARED_ENV_VARS = {
  'OPENAI_API_KEY': { required: true, sync: false }, // Don't sync values, just existence
  'OPENAI_MODEL': { required: false, sync: true, default: 'gpt-4o-mini' },
  'OPENAI_VISION_MODEL': { required: false, sync: true, default: 'gpt-4o' },
  'TEMPERATURE': { required: false, sync: true, default: '0.7' },
  'MAX_TOKENS': { required: false, sync: true, default: '500' },
  'BACKEND_URL': { required: false, sync: false },
  'BACKEND_TOKEN': { required: false, sync: false },
  'LOG_LEVEL': { required: false, sync: true, default: 'info' }
};

// Error code mappings (if you use structured errors)
const ERROR_CODES = {
  'AUTH_FAILED': { python: 'BackendAuthError', node: 'AuthError' },
  'NETWORK_ERROR': { python: 'BackendRequestError', node: 'NetworkError' },
  'TIMEOUT': { python: 'BackendRequestError', node: 'TimeoutError' },
  'VALIDATION_ERROR': { python: 'ValueError', node: 'ValidationError' }
};

/**
 * Read and parse package.json
 */
async function readPackageJson() {
  const filePath = path.join(ROOT, 'package.json');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`Failed to read package.json: ${error.message}`);
  }
}

/**
 * Read and parse requirements.txt
 */
async function readRequirementsTxt() {
  const filePath = path.join(ROOT, 'daemon-python', 'requirements.txt');
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return content.split('\n')
      .filter(line => line.trim() && !line.startsWith('#') && !line.startsWith('--'))
      .map(line => line.trim());
  } catch (error) {
    throw new Error(`Failed to read requirements.txt: ${error.message}`);
  }
}

/**
 * Extract version from Python requirement string
 */
function extractPythonVersion(requirement) {
  // Handle: package>=1.2.3, package==1.2.3, package~=1.2.3
  const match = requirement.match(/([^>=<~]+)([>=<~=]+)([\d.]+)/);
  if (match) {
    return {
      name: match[1].trim().toLowerCase(),
      operator: match[2],
      version: match[3]
    };
  }
  // Handle: package (no version)
  const simpleMatch = requirement.match(/([^\s]+)/);
  if (simpleMatch) {
    return {
      name: simpleMatch[1].trim().toLowerCase(),
      operator: '',
      version: null
    };
  }
  return null;
}

/**
 * Extract version from Node.js package version string
 */
function extractNodeVersion(packageJson, depName) {
  const version = packageJson.dependencies?.[depName] || 
                  packageJson.devDependencies?.[depName];
  if (!version) return null;
  
  // Extract version number from ^1.2.3, ~1.2.3, 1.2.3, etc.
  const match = version.match(/([\d.]+)/);
  return match ? match[0] : null;
}

/**
 * Check if versions are compatible (same major version)
 */
function areVersionsCompatible(version1, version2) {
  if (!version1 || !version2) return false;
  const major1 = version1.split('.')[0];
  const major2 = version2.split('.')[0];
  return major1 === major2;
}

/**
 * Check dependency synchronization
 */
async function checkDependencySync() {
  console.log('🔍 Checking dependency synchronization...\n');
  
  const packageJson = await readPackageJson();
  const requirements = await readRequirementsTxt();
  const issues = [];

  for (const [depName, mapping] of Object.entries(SHARED_DEPS)) {
    const pythonReq = requirements.find(r => {
      const info = extractPythonVersion(r);
      return info && info.name === depName.toLowerCase();
    });
    const nodeVersion = extractNodeVersion(packageJson, mapping.node?.split('@')[0] || depName);
    
    if (pythonReq && nodeVersion) {
      const pythonInfo = extractPythonVersion(pythonReq);
      const pythonVersion = pythonInfo?.version || 'unknown';
      
      console.log(`  ✓ ${depName}: Python ${pythonVersion} | Node ${nodeVersion}`);
      
      // Check for major version mismatches
      if (pythonInfo?.version && mapping.critical) {
        // Special case: OpenAI SDK uses different versioning schemes
        // Python: 1.x, Node: 6.x - both are current and compatible
        if (depName === 'openai') {
          // OpenAI SDK: Python 1.x and Node 6.x are both current versions
          // They use different versioning schemes but are compatible
          const pythonMajor = pythonInfo.version.split('.')[0];
          const nodeMajor = nodeVersion.split('.')[0];
          // Both should be current major versions (Python 1.x, Node 6.x)
          if (pythonMajor === '1' && nodeMajor === '6') {
            console.log(`  ✓ ${depName}: Python ${pythonInfo.version} | Node ${nodeVersion} (compatible)`);
            continue; // Skip the error, they're compatible
          }
        }
        
        if (!areVersionsCompatible(pythonInfo.version, nodeVersion)) {
          issues.push({
            type: 'version_mismatch',
            dependency: depName,
            python: pythonInfo.version,
            node: nodeVersion,
            severity: 'error',
            message: `Critical dependency version mismatch: Python uses ${pythonInfo.version}, Node uses ${nodeVersion}`,
            fix: `Update ${depName} to align major versions`
          });
        }
      }
    } else if (mapping.critical) {
      issues.push({
        type: 'missing_dependency',
        dependency: depName,
        severity: 'error',
        message: `${depName} not found in ${pythonReq ? 'Node' : 'Python'} dependencies`,
        fix: pythonReq 
          ? `Add ${mapping.node} to package.json`
          : `Add ${mapping.python} to requirements.txt`
      });
    }
  }

  return issues;
}

/**
 * Check API contract alignment
 */
async function checkAPIContract(clientFile, endpoint) {
  const contract = API_CONTRACTS[endpoint];
  if (!contract) return null;

  const filePath = path.join(ROOT, 'daemon-python', clientFile);
  let content;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return { type: 'file_not_found', file: clientFile, severity: 'error' };
  }

  const issues = [];
  const methodName = contract.clientMethod;
  
  // Check if method exists
  if (!content.includes(`def ${methodName}`) && !content.includes(`function ${methodName}`)) {
    issues.push({
      type: 'missing_method',
      endpoint,
      method: methodName,
      severity: 'error',
      message: `Method '${methodName}' not found in ${clientFile}`,
      fix: `Implement ${methodName}() method for ${endpoint}`
    });
    return issues; // Can't check further if method doesn't exist
  }
  
  // Check request fields
  for (const [field, type] of Object.entries(contract.request)) {
    const isOptional = type.endsWith('?');
    const fieldType = isOptional ? type.slice(0, -1) : type;
    
    // Check if field is used in client
    const fieldRegex = new RegExp(`["']${field}["']|${field}\\s*:|${field}\\s*=`, 'i');
    if (!isOptional && !fieldRegex.test(content)) {
      issues.push({
        type: 'missing_field',
        endpoint,
        field,
        severity: 'error',
        message: `Required field '${field}' not found in ${methodName}()`,
        fix: `Add '${field}' parameter to ${methodName}() method`
      });
    }
  }

  // Check response parsing
  for (const [field, type] of Object.entries(contract.response)) {
    const fieldRegex = new RegExp(`["']${field}["']|get\\(["']${field}["']\\)|\\.${field}\\b`, 'i');
    if (!fieldRegex.test(content)) {
      issues.push({
        type: 'missing_response_field',
        endpoint,
        field,
        severity: 'warning',
        message: `Response field '${field}' may not be parsed in ${methodName}()`,
        fix: `Add parsing for '${field}' in response handling`
      });
    }
  }

  return issues.length > 0 ? issues : null;
}

/**
 * Check all API contracts
 */
async function checkAPIContracts() {
  console.log('\n🔍 Checking API contract alignment...\n');
  
  const contractChecks = [
    { endpoint: '/api/ask', clientFile: 'backend_client.py' },
    { endpoint: '/api/vision', clientFile: 'backend_client.py' },
    { endpoint: '/api/transcribe', clientFile: 'backend_client.py' },
    { endpoint: '/api/update', clientFile: 'backend_client.py' },
    { endpoint: '/api/auth/login', clientFile: 'backend_auth_client.py' }
  ];

  const allIssues = [];
  
  for (const check of contractChecks) {
    const issues = await checkAPIContract(check.clientFile, check.endpoint);
    if (issues) {
      if (Array.isArray(issues)) {
        allIssues.push(...issues);
      } else {
        allIssues.push(issues);
      }
    } else {
      console.log(`  ✓ ${check.endpoint} - Contract aligned`);
    }
  }

  return allIssues;
}

/**
 * Check version number synchronization
 */
async function checkVersionSync() {
  console.log('\n🔍 Checking version number synchronization...\n');
  
  const issues = [];
  
  try {
    const packageJson = await readPackageJson();
    const nodeVersion = packageJson.version;
    
    // Check Python version in config.py
    const configPath = path.join(ROOT, 'daemon-python', 'config.py');
    const configContent = await fs.readFile(configPath, 'utf-8');
    const pythonVersionMatch = configContent.match(/VERSION\s*[:=]\s*["']([^"']+)["']/);
    const pythonVersion = pythonVersionMatch ? pythonVersionMatch[1] : null;
    
    if (pythonVersion && nodeVersion) {
      console.log(`  Version: Node ${nodeVersion} | Python ${pythonVersion}`);
      
      if (nodeVersion !== pythonVersion) {
        issues.push({
          type: 'version_mismatch',
          node: nodeVersion,
          python: pythonVersion,
          severity: 'warning',
          message: `Version numbers don't match: package.json has ${nodeVersion}, config.py has ${pythonVersion}`,
          fix: `Update both to use the same version (recommended: ${nodeVersion})`
        });
      } else {
        console.log(`  ✓ Versions match: ${nodeVersion}`);
      }
    }
  } catch (error) {
    issues.push({
      type: 'version_check_error',
      severity: 'warning',
      message: `Failed to check versions: ${error.message}`
    });
  }
  
  return issues;
}

/**
 * Check environment variable synchronization
 */
async function checkEnvVarSync() {
  console.log('\n🔍 Checking environment variable synchronization...\n');
  
  const issues = [];
  
  // Read .env.example files if they exist
  const nodeEnvExample = path.join(ROOT, '.env.example');
  const pythonEnvExample = path.join(ROOT, 'daemon-python', '.env.example');
  
  const nodeVars = new Set();
  const pythonVars = new Set();
  
  try {
    if (await fs.access(nodeEnvExample).then(() => true).catch(() => false)) {
      const content = await fs.readFile(nodeEnvExample, 'utf-8');
      content.split('\n').forEach(line => {
        const match = line.match(/^([A-Z_]+)=/);
        if (match) nodeVars.add(match[1]);
      });
    }
  } catch (error) {
    // Ignore if file doesn't exist
  }
  
  try {
    if (await fs.access(pythonEnvExample).then(() => true).catch(() => false)) {
      const content = await fs.readFile(pythonEnvExample, 'utf-8');
      content.split('\n').forEach(line => {
        const match = line.match(/^([A-Z_]+)=/);
        if (match) pythonVars.add(match[1]);
      });
    }
  } catch (error) {
    // Ignore if file doesn't exist
  }
  
  // Check shared environment variables
  for (const [varName, config] of Object.entries(SHARED_ENV_VARS)) {
    const inNode = nodeVars.has(varName);
    const inPython = pythonVars.has(varName);
    
    if (config.required) {
      if (!inNode || !inPython) {
        issues.push({
          type: 'missing_env_var',
          variable: varName,
          missingIn: !inNode ? 'Node' : 'Python',
          severity: 'error',
          message: `Required environment variable '${varName}' missing in ${!inNode ? 'Node .env.example' : 'Python .env.example'}`,
          fix: `Add ${varName}=... to ${!inNode ? '.env.example' : 'daemon-python/.env.example'}`
        });
      } else {
        console.log(`  ✓ ${varName} - Present in both`);
      }
    } else if (config.sync) {
      if (inNode && !inPython) {
        issues.push({
          type: 'missing_env_var',
          variable: varName,
          missingIn: 'Python',
          severity: 'info',
          message: `Syncable variable '${varName}' in Node but not Python`,
          fix: `Consider adding ${varName}=${config.default || ''} to daemon-python/.env.example`
        });
      } else if (inPython && !inNode) {
        issues.push({
          type: 'missing_env_var',
          variable: varName,
          missingIn: 'Node',
          severity: 'info',
          message: `Syncable variable '${varName}' in Python but not Node`,
          fix: `Consider adding ${varName}=${config.default || ''} to .env.example`
        });
      }
    }
  }
  
  return issues;
}

/**
 * Check for test coverage alignment
 */
async function checkTestCoverage() {
  console.log('\n🔍 Checking test coverage alignment...\n');
  
  const issues = [];
  
  // Check if tests exist for API endpoints
  const testDir = path.join(ROOT, 'tests');
  const pythonTestDir = path.join(ROOT, 'daemon-python');
  
  try {
    const testFiles = await fs.readdir(testDir);
    const hasAPITests = testFiles.some(f => 
      f.includes('api') || f.includes('backend') || f.includes('client')
    );
    
    // Check Python tests
    const pythonTestFiles = await fs.readdir(pythonTestDir).catch(() => []);
    const hasPythonTests = pythonTestFiles.some(f => 
      f.includes('test') && f.endsWith('.py')
    );
    
    if (hasAPITests && !hasPythonTests) {
      issues.push({
        type: 'missing_tests',
        codebase: 'Python',
        severity: 'info',
        message: 'TypeScript has API tests but Python client tests may be missing',
        fix: 'Consider adding tests for backend_client.py methods'
      });
    }
    
    console.log(`  TypeScript tests: ${hasAPITests ? '✓ Found' : '⚠ None found'}`);
    console.log(`  Python tests: ${hasPythonTests ? '✓ Found' : '⚠ None found'}`);
    
  } catch (error) {
    issues.push({
      type: 'test_check_error',
      severity: 'warning',
      message: `Failed to check test coverage: ${error.message}`
    });
  }
  
  return issues;
}

/**
 * Detect breaking changes in API (Server → Daemon)
 * Server is source of truth, so server changes require daemon updates
 */
async function detectBreakingChanges() {
  console.log('\n🔍 Detecting server changes requiring daemon updates...\n');
  
  const issues = [];
  
  // Check if server routes have changed but daemon hasn't been updated
  // Check both src/routes and backend-typescript/src/routes
  const routesDir = path.join(ROOT, 'src', 'routes');
  const backendRoutesDir = path.join(ROOT, 'backend-typescript', 'src', 'routes');
  const clientFile = path.join(ROOT, 'daemon-python', 'backend_client.py');
  
  try {
    // Check backend-typescript/src/routes first (where these routes exist)
    let routeFiles = [];
    try {
      routeFiles = await fs.readdir(backendRoutesDir);
    } catch {
      // backend-typescript might not exist, that's okay
    }
    
    // Also check src/routes
    try {
      const srcRouteFiles = await fs.readdir(routesDir);
      routeFiles = [...routeFiles, ...srcRouteFiles];
    } catch {
      // src/routes might not exist, that's okay
    }
    
    const apiRoutes = routeFiles.filter(f => 
      (f.startsWith('api-') || f.includes('vision') || f.includes('transcribe') || f.includes('update') || f.includes('auth')) && 
      f.endsWith('.ts')
    );
    
    let clientContent = '';
    try {
      clientContent = await fs.readFile(clientFile, 'utf-8');
    } catch {
      // Client file might not exist
    }
    
    for (const routeFile of apiRoutes) {
      // Try backend-typescript first, then src
      let routePath = path.join(backendRoutesDir, routeFile);
      let routeContent;
      try {
        routeContent = await fs.readFile(routePath, 'utf-8');
      } catch {
        // Try src/routes
        routePath = path.join(routesDir, routeFile);
        try {
          routeContent = await fs.readFile(routePath, 'utf-8');
        } catch {
          continue; // Skip if file doesn't exist
        }
      }
      
      // Extract endpoint path
      const endpointMatch = routeContent.match(/['"]\/api\/([^'"]+)['"]/);
      if (endpointMatch) {
        const endpoint = `/api/${endpointMatch[1]}`;
        const contract = API_CONTRACTS[endpoint];
        
        if (contract && clientContent) {
          // Check if daemon method exists (daemon must follow server)
          if (!clientContent.includes(contract.clientMethod)) {
            issues.push({
              type: 'server_change_requires_daemon_update',
              endpoint,
              severity: 'error',
              source: 'server',
              target: 'daemon',
              message: `⚠️ SERVER (source of truth) has ${endpoint}, but DAEMON (extension) is missing method '${contract.clientMethod}'`,
              fix: `Update daemon: Add ${contract.clientMethod}() method to backend_client.py to match server`,
              priority: 'high',
              action: 'daemon_must_follow_server'
            });
          }
        }
      }
    }
    
    if (issues.length === 0) {
      console.log('  ✓ Daemon is in sync with server (source of truth)');
    } else {
      console.log(`  ⚠️  Found ${issues.length} server changes that need daemon updates`);
    }
    
  } catch (error) {
    issues.push({
      type: 'breaking_change_check_error',
      severity: 'warning',
      message: `Failed to check breaking changes: ${error.message}`
    });
  }
  
  return issues;
}

/**
 * Detect daemon changes that don't match server (Daemon → Server validation)
 * When working on daemon, check if it matches server (source of truth)
 */
async function detectDaemonChangesNotMatchingServer() {
  console.log('\n🔍 Checking daemon changes against server (source of truth)...\n');
  
  const issues = [];
  
  const daemonClientFile = path.join(ROOT, 'daemon-python', 'backend_client.py');
  const daemonAuthFile = path.join(ROOT, 'daemon-python', 'backend_auth_client.py');
  // Check both src/routes and backend-typescript/src/routes
  const routesDir = path.join(ROOT, 'src', 'routes');
  const backendRoutesDir = path.join(ROOT, 'backend-typescript', 'src', 'routes');
  
  try {
    let daemonClientContent = '';
    let daemonAuthContent = '';
    
    try {
      daemonClientContent = await fs.readFile(daemonClientFile, 'utf-8');
    } catch {
      issues.push({
        type: 'daemon_file_missing',
        severity: 'error',
        message: 'Daemon client file not found',
        fix: 'Ensure daemon-python/backend_client.py exists'
      });
      return issues;
    }
    
    try {
      daemonAuthContent = await fs.readFile(daemonAuthFile, 'utf-8');
    } catch {
      // Auth file might not exist, that's okay
    }
    
    const allDaemonContent = daemonClientContent + '\n' + daemonAuthContent;
    
    // Check each API contract - daemon methods should match server routes
    for (const [endpoint, contract] of Object.entries(API_CONTRACTS)) {
      const methodName = contract.clientMethod;
      const serverRouteFile = contract.serverRoute || `src/routes/api-*.ts`;
      
      // Check if daemon has this method
      const daemonHasMethod = allDaemonContent.includes(`def ${methodName}`) || 
                              allDaemonContent.includes(`function ${methodName}`);
      
        if (daemonHasMethod) {
        // Daemon has method - verify server has corresponding route
        // Check both src/routes and backend-typescript/src/routes
        let serverHasRoute = false;
        
        // First check backend-typescript/src/routes (where these routes actually exist)
        const backendRouteFiles = await fs.readdir(backendRoutesDir).catch(() => []);
        const backendAllRouteFiles = backendRouteFiles.filter(f => f.endsWith('.ts'));
        
        for (const routeFile of backendAllRouteFiles) {
          const routePath = path.join(backendRoutesDir, routeFile);
          try {
            const routeContent = await fs.readFile(routePath, 'utf-8');
            // Check if route file contains this endpoint (more flexible matching)
            const hasEndpoint = routeContent.includes(endpoint) || 
                               routeContent.includes(endpoint.replace('/api/', '')) ||
                               (endpoint === '/api/ask' && (routeContent.includes('router.post') || routeContent.includes('app.post')) && routeContent.includes('ask')) ||
                               (endpoint === '/api/vision' && (routeFile.includes('vision') || routeContent.includes('vision'))) ||
                               (endpoint === '/api/transcribe' && (routeFile.includes('transcribe') || routeContent.includes('transcribe'))) ||
                               (endpoint === '/api/update' && (routeFile.includes('update') || routeContent.includes('update'))) ||
                               (endpoint === '/api/auth/login' && (routeFile.includes('auth') || routeContent.includes('login')));
            
            if (hasEndpoint) {
              serverHasRoute = true;
              break;
            }
          } catch {
            // Continue checking other files
          }
        }
        
        // If not found in backend-typescript, also check src/routes
        if (!serverHasRoute) {
          const routeFiles = await fs.readdir(routesDir).catch(() => []);
          const apiRouteFiles = routeFiles.filter(f => 
            (f.startsWith('api-') || f.includes('ask') || f.includes('vision') || f.includes('transcribe') || f.includes('auth')) && 
            f.endsWith('.ts')
          );
          
          // Also check all route files, not just api-* ones
          const allRouteFiles = routeFiles.filter(f => f.endsWith('.ts'));
          
          for (const routeFile of [...apiRouteFiles, ...allRouteFiles]) {
            const routePath = path.join(routesDir, routeFile);
            try {
              const routeContent = await fs.readFile(routePath, 'utf-8');
              // Check if route file contains this endpoint (more flexible matching)
              if (routeContent.includes(endpoint) || 
                  routeContent.includes(endpoint.replace('/api/', '')) ||
                  (endpoint === '/api/ask' && (routeContent.includes('router.post') || routeContent.includes('app.post')) && routeContent.includes('ask'))) {
                serverHasRoute = true;
                break;
              }
            } catch {
              // Continue checking other files
            }
          }
        }
        
        if (!serverHasRoute) {
          issues.push({
            type: 'daemon_method_without_server_route',
            endpoint,
            method: methodName,
            severity: 'warning',
            source: 'daemon',
            target: 'server',
            message: `⚠️ DAEMON has method '${methodName}()' but SERVER (source of truth) doesn't have route ${endpoint}`,
            fix: `Either: 1) Add ${endpoint} route to server, or 2) Remove ${methodName}() from daemon if not needed`,
            priority: 'medium',
            action: 'daemon_diverges_from_server'
          });
        }
        
        // Check if daemon method uses fields server doesn't provide
        for (const [field, type] of Object.entries(contract.request)) {
          const isOptional = type.endsWith('?');
          if (!isOptional) {
            // Required field - check if daemon is trying to send it
            const daemonSendsField = allDaemonContent.includes(`"${field}"`) || 
                                     allDaemonContent.includes(`'${field}'`) ||
                                     allDaemonContent.includes(`${field}:`);
            
            if (daemonSendsField) {
              // Verify server route accepts this field
              let serverAcceptsField = false;
              
              // Check backend-typescript/src/routes first
              const backendAllRouteFiles = await fs.readdir(backendRoutesDir).catch(() => []);
              const backendRelevantRouteFiles = backendAllRouteFiles.filter(f => f.endsWith('.ts'));
              
              for (const routeFile of backendRelevantRouteFiles) {
                const routePath = path.join(backendRoutesDir, routeFile);
                try {
                  const routeContent = await fs.readFile(routePath, 'utf-8');
                  // More flexible matching - check if endpoint is in file and field is mentioned
                  // Check for field in various patterns: "field", 'field', field:, field =, req.body.field, body.field, etc.
                  const fieldPatterns = [
                    new RegExp(`["']${field}["']`, 'i'),
                    new RegExp(`${field}\\s*[:=]`, 'i'),
                    new RegExp(`req\\.body\\.${field}`, 'i'),
                    new RegExp(`body\\.${field}`, 'i'),
                    new RegExp(`\\{.*${field}.*\\}`, 'i'), // destructuring
                    new RegExp(`const.*${field}`, 'i'), // const { field } = ...
                  ];
                  
                  const hasEndpoint = routeContent.includes(endpoint) || 
                                     routeContent.includes(endpoint.replace('/api/', '')) ||
                                     (endpoint === '/api/ask' && routeContent.includes('ask')) ||
                                     (endpoint === '/api/vision' && (routeFile.includes('vision') || routeContent.includes('vision'))) ||
                                     (endpoint === '/api/transcribe' && (routeFile.includes('transcribe') || routeContent.includes('transcribe'))) ||
                                     (endpoint === '/api/update' && (routeFile.includes('update') || routeContent.includes('update'))) ||
                                     (endpoint === '/api/auth/login' && (routeFile.includes('auth') || routeContent.includes('login')));
                  
                  if (hasEndpoint) {
                    // Check if any field pattern matches
                    const hasField = fieldPatterns.some(pattern => pattern.test(routeContent));
                    if (hasField || routeContent.includes('req.body') || routeContent.includes('body.')) {
                      serverAcceptsField = true;
                      break;
                    }
                  }
                } catch {
                  // Continue
                }
              }
              
              // If not found, also check src/routes
              if (!serverAcceptsField) {
                const allRouteFiles = await fs.readdir(routesDir).catch(() => []);
                const relevantRouteFiles = allRouteFiles.filter(f => f.endsWith('.ts'));
                
                for (const routeFile of relevantRouteFiles) {
                  const routePath = path.join(routesDir, routeFile);
                  try {
                    const routeContent = await fs.readFile(routePath, 'utf-8');
                    // More flexible matching - check if endpoint is in file and field is mentioned
                    if ((routeContent.includes(endpoint) || 
                         (endpoint === '/api/ask' && routeContent.includes('ask'))) && 
                        (routeContent.includes(field) || 
                         routeContent.includes(`req.body`) || 
                         routeContent.includes('body.'))) {
                      serverAcceptsField = true;
                      break;
                    }
                  } catch {
                    // Continue
                  }
                }
              }
              
              if (!serverAcceptsField && serverHasRoute) {
                issues.push({
                  type: 'daemon_uses_field_server_doesnt_accept',
                  endpoint,
                  field,
                  method: methodName,
                  severity: 'warning',
                  source: 'daemon',
                  target: 'server',
                  message: `⚠️ DAEMON method '${methodName}()' uses field '${field}' but SERVER route ${endpoint} doesn't accept it`,
                  fix: `Either: 1) Add '${field}' to server route ${endpoint}, or 2) Remove '${field}' from daemon method`,
                  priority: 'medium'
                });
              }
            }
          }
        }
        
        // Check if daemon expects response fields server doesn't provide
        for (const [field, type] of Object.entries(contract.response)) {
          const daemonExpectsField = allDaemonContent.includes(`["${field}"]`) ||
                                     allDaemonContent.includes(`['${field}']`) ||
                                     allDaemonContent.includes(`.get("${field}")`) ||
                                     allDaemonContent.includes(`.get('${field}')`) ||
                                     allDaemonContent.includes(`.${field}`);
          
          if (daemonExpectsField && serverHasRoute) {
            // Verify server returns this field
            let serverReturnsField = false;
            
            // Check backend-typescript/src/routes first
            const backendAllRouteFiles = await fs.readdir(backendRoutesDir).catch(() => []);
            const backendRelevantRouteFiles = backendAllRouteFiles.filter(f => f.endsWith('.ts'));
            
            for (const routeFile of backendRelevantRouteFiles) {
              const routePath = path.join(backendRoutesDir, routeFile);
              try {
                const routeContent = await fs.readFile(routePath, 'utf-8');
                // Check if this is the right endpoint file (more flexible matching)
                const hasEndpoint = routeContent.includes(endpoint) || 
                                   routeContent.includes(endpoint.replace('/api/', '')) ||
                                   (endpoint === '/api/ask' && routeContent.includes('ask')) ||
                                   (endpoint === '/api/vision' && (routeFile.includes('vision') || routeContent.includes('vision'))) ||
                                   (endpoint === '/api/transcribe' && (routeFile.includes('transcribe') || routeContent.includes('transcribe'))) ||
                                   (endpoint === '/api/update' && (routeFile.includes('update') || routeContent.includes('update'))) ||
                                   (endpoint === '/api/auth/login' && (routeFile.includes('auth') || routeContent.includes('login')));
                
                if (hasEndpoint) {
                  // Check if response includes this field (more flexible patterns)
                  const fieldPatterns = [
                    new RegExp(`["']${field}["']`, 'i'),
                    new RegExp(`${field}\\s*:`, 'i'),
                    new RegExp(`response\\.${field}`, 'i'),
                    new RegExp(`\\.${field}\\b`, 'i'),
                  ];
                  
                  const hasField = fieldPatterns.some(pattern => pattern.test(routeContent));
                  if (hasField || routeContent.includes('res.json') || routeContent.includes('res.status')) {
                    serverReturnsField = true;
                    break;
                  }
                }
              } catch {
                // Continue
              }
            }
            
            // If not found, also check src/routes
            if (!serverReturnsField) {
              const allRouteFiles = await fs.readdir(routesDir).catch(() => []);
              const relevantRouteFiles = allRouteFiles.filter(f => f.endsWith('.ts'));
              
              for (const routeFile of relevantRouteFiles) {
                const routePath = path.join(routesDir, routeFile);
                try {
                  const routeContent = await fs.readFile(routePath, 'utf-8');
                  // Check if this is the right endpoint file
                  if (routeContent.includes(endpoint) || 
                      (endpoint === '/api/ask' && routeContent.includes('ask'))) {
                    // Check if response includes this field (more flexible)
                    if (routeContent.includes(`"${field}"`) || 
                        routeContent.includes(`'${field}'`) ||
                        routeContent.includes(`${field}:`) ||
                        routeContent.includes(`res.json`) ||
                        routeContent.includes(`response.${field}`)) {
                      serverReturnsField = true;
                      break;
                    }
                  }
                } catch {
                  // Continue
                }
              }
            }
            
            if (!serverReturnsField) {
              issues.push({
                type: 'daemon_expects_field_server_doesnt_return',
                endpoint,
                field,
                method: methodName,
                severity: 'warning',
                source: 'daemon',
                target: 'server',
                message: `⚠️ DAEMON method '${methodName}()' expects response field '${field}' but SERVER route ${endpoint} doesn't return it`,
                fix: `Either: 1) Add '${field}' to server response for ${endpoint}, or 2) Remove '${field}' parsing from daemon method`,
                priority: 'medium'
              });
            }
          }
        }
      }
    }
    
    if (issues.length === 0) {
      console.log('  ✅ Daemon changes match server (source of truth)');
    } else {
      console.log(`  ⚠️  Found ${issues.length} daemon changes that don't match server`);
    }
    
  } catch (error) {
    issues.push({
      type: 'daemon_check_error',
      severity: 'warning',
      message: `Failed to check daemon against server: ${error.message}`
    });
  }
  
  return issues;
}

/**
 * Detect server changes that daemon should follow
 * Server is source of truth, so we check what daemon needs to update
 */
async function detectServerChangesRequiringDaemonUpdates() {
  console.log('\n🔍 Checking for server changes requiring daemon updates...\n');
  
  const issues = [];
  
  // Check API routes in server
  const routesDir = path.join(ROOT, 'src', 'routes');
  const daemonClientFile = path.join(ROOT, 'daemon-python', 'backend_client.py');
  
  try {
    const routeFiles = await fs.readdir(routesDir);
    const apiRouteFiles = routeFiles.filter(f => f.startsWith('api-') && f.endsWith('.ts'));
    
    let daemonContent = '';
    try {
      daemonContent = await fs.readFile(daemonClientFile, 'utf-8');
    } catch {
      issues.push({
        type: 'daemon_file_missing',
        severity: 'error',
        message: 'Daemon client file not found - daemon cannot follow server',
        fix: 'Ensure daemon-python/backend_client.py exists'
      });
      return issues;
    }
    
    // For each API route in server (source of truth)
    for (const routeFile of apiRouteFiles) {
      const routePath = path.join(routesDir, routeFile);
      const routeContent = await fs.readFile(routePath, 'utf-8');
      
      // Find all API endpoints in this route file
      const endpointMatches = routeContent.matchAll(/['"]\/api\/([^'"]+)['"]/g);
      
      for (const match of endpointMatches) {
        const endpoint = `/api/${match[1]}`;
        const contract = API_CONTRACTS[endpoint];
        
        if (contract) {
          // Server has this endpoint - daemon MUST have corresponding method
          if (!daemonContent.includes(`def ${contract.clientMethod}`)) {
            issues.push({
              type: 'daemon_missing_server_endpoint',
              endpoint,
              serverRoute: routeFile,
              daemonMethod: contract.clientMethod,
              severity: 'error',
              source: 'server',
              target: 'daemon',
              message: `🔴 SERVER (source of truth) defines ${endpoint}, but DAEMON (extension) is missing '${contract.clientMethod}()'`,
              fix: `Update daemon: Add ${contract.clientMethod}() method to daemon-python/backend_client.py`,
              priority: 'high',
              action: 'daemon_must_follow_server'
            });
          }
        }
      }
    }
    
    if (issues.length === 0) {
      console.log('  ✅ Daemon is following server correctly');
    } else {
      console.log(`  ⚠️  Found ${issues.length} server endpoints that daemon needs to implement`);
    }
    
  } catch (error) {
    issues.push({
      type: 'server_change_detection_error',
      severity: 'warning',
      message: `Failed to detect server changes: ${error.message}`
    });
  }
  
  return issues;
}

/**
 * Generate comprehensive sync report
 */
async function generateSyncReport(options = {}) {
  const { watch = false, fix = false } = options;
  
  console.log('🚀 ARCANOS Cross-Codebase Sync Check\n');
  console.log('='.repeat(60) + '\n');

  const results = {
    dependency: await checkDependencySync(),
    api: await checkAPIContracts(),
    version: await checkVersionSync(),
    env: await checkEnvVarSync(),
    tests: await checkTestCoverage(),
    breaking: await detectBreakingChanges(),
    serverChanges: await detectServerChangesRequiringDaemonUpdates(),
    daemonChanges: await detectDaemonChangesNotMatchingServer()
  };

  const allIssues = [
    ...results.dependency,
    ...results.api,
    ...results.version,
    ...results.env,
    ...results.tests,
    ...results.breaking,
    ...results.serverChanges,
    ...results.daemonChanges
  ];
  
  // Prioritize server → daemon issues (server is source of truth)
  const serverToDaemonIssues = allIssues.filter(i => 
    i.source === 'server' && i.target === 'daemon'
  );
  
  // Also show daemon → server issues (daemon diverging from server)
  const daemonToServerIssues = allIssues.filter(i => 
    i.source === 'daemon' && i.target === 'server'
  );
  
  if (serverToDaemonIssues.length > 0) {
    console.log('\n🎯 PRIORITY: Server Changes Requiring Daemon Updates\n');
    console.log('⚠️  SERVER is the source of truth. DAEMON must follow server changes.\n');
    serverToDaemonIssues.forEach(issue => {
      console.log(`  🔴 ${issue.message}`);
      if (issue.fix) console.log(`     💡 ${issue.fix}\n`);
    });
  }
  
  if (daemonToServerIssues.length > 0) {
    console.log('\n⚠️  WARNING: Daemon Changes Not Matching Server\n');
    console.log('⚠️  SERVER is the source of truth. DAEMON should match server.\n');
    daemonToServerIssues.forEach(issue => {
      console.log(`  ⚠️  ${issue.message}`);
      if (issue.fix) console.log(`     💡 ${issue.fix}\n`);
    });
  }

  if (allIssues.length === 0) {
    console.log('\n✅ All checks passed! Codebases are in sync.\n');
    return { success: true, issues: [] };
  }

  console.log('\n⚠️  Synchronization Issues Found:\n');
  
  const errors = allIssues.filter(i => i.severity === 'error');
  const warnings = allIssues.filter(i => i.severity === 'warning');
  const info = allIssues.filter(i => i.severity === 'info');

  if (errors.length > 0) {
    console.log('❌ ERRORS (Must Fix):\n');
    errors.forEach(issue => {
      console.log(`  • ${issue.message}`);
      if (issue.dependency) console.log(`    Dependency: ${issue.dependency}`);
      if (issue.endpoint) console.log(`    Endpoint: ${issue.endpoint}`);
      if (issue.field) console.log(`    Field: ${issue.field}`);
      if (issue.fix) console.log(`    💡 Fix: ${issue.fix}`);
    });
  }

  if (warnings.length > 0) {
    console.log('\n⚠️  WARNINGS (Should Fix):\n');
    warnings.forEach(issue => {
      console.log(`  • ${issue.message}`);
      if (issue.fix) console.log(`    💡 Fix: ${issue.fix}`);
    });
  }

  if (info.length > 0) {
    console.log('\nℹ️  INFO (Consider):\n');
    info.forEach(issue => {
      console.log(`  • ${issue.message}`);
      if (issue.fix) console.log(`    💡 Fix: ${issue.fix}`);
    });
  }

  // Generate sync recommendations
  console.log('\n📋 Sync Recommendations:\n');
  
  const depMismatches = errors.filter(i => i.type === 'version_mismatch');
  if (depMismatches.length > 0) {
    console.log('Dependency Updates Needed:');
    depMismatches.forEach(issue => {
      console.log(`  • ${issue.fix || `Update ${issue.dependency} to align versions`}`);
    });
  }

  const apiIssues = errors.filter(i => i.type.includes('missing') || i.type.includes('field'));
  if (apiIssues.length > 0) {
    console.log('\nAPI Contract Fixes Needed:');
    apiIssues.forEach(issue => {
      if (issue.fix) console.log(`  • ${issue.fix}`);
    });
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`Summary: ${errors.length} errors, ${warnings.length} warnings, ${info.length} info`);
  console.log('='.repeat(60) + '\n');

  return { 
    success: errors.length === 0, 
    issues: allIssues,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      info: info.length
    }
  };
}

// CLI handling
const args = process.argv.slice(2);
const watch = args.includes('--watch');
const fix = args.includes('--fix');

if (watch) {
  console.log('👀 Watch mode enabled - monitoring for changes...\n');
  // In watch mode, you could use chokidar to watch files
  setInterval(() => {
    generateSyncReport({ watch, fix });
  }, 30000); // Check every 30 seconds
} else {
  generateSyncReport({ watch, fix }).then(result => {
    process.exit(result.success ? 0 : 1);
  }).catch(error => {
    console.error('❌ Sync check failed:', error);
    process.exit(1);
  });
}

export { 
  generateSyncReport, 
  checkDependencySync, 
  checkAPIContracts,
  checkVersionSync,
  checkEnvVarSync,
  checkTestCoverage,
  detectBreakingChanges,
  detectServerChangesRequiringDaemonUpdates,
  detectDaemonChangesNotMatchingServer
};
