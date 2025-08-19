#!/usr/bin/env node

/**
 * Route Security Scan - ConfirmGate Compliance Audit
 * 
 * Scans all route files to ensure sensitive endpoints have confirmGate middleware
 * and that no route bypasses the confirmation requirement.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROUTES_DIR = path.join(__dirname, '..', 'src', 'routes');
const SENSITIVE_METHODS = ['POST', 'PUT', 'DELETE', 'PATCH'];

// Safe endpoints that should NOT have confirmGate
const SAFE_PATTERNS = [
  /GET.*\/health/,
  /GET.*\//,  // Root GET endpoints
  /GET.*\/memory\/health/,
  /GET.*\/memory\/load/,
  /GET.*\/memory\/list/,
  /GET.*\/memory\/view/,
  /GET.*\/workers\/status/,
  /GET.*\/status/,
  /GET.*\/orchestration\/status/,
  /GET.*\/sdk\/diagnostics/,
  /GET.*\/sdk\/workers\/status/,
  /GET.*\/backstage/,
  /POST\s+\/ask$/
];

function extractRoutes(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const routes = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    
    // Match router.method() patterns
    const routeMatch = line.match(/router\.(get|post|put|delete|patch)\s*\(\s*['"](.*?)['"],?\s*(.*?)\s*(?:,|\))/);
    if (routeMatch) {
      const method = routeMatch[1].toUpperCase();
      const path = routeMatch[2];
      const handler = routeMatch[3];
      
      routes.push({
        method,
        path,
        handler,
        line: i + 1,
        raw: line,
        hasConfirmGate: handler.includes('confirmGate'),
        file: filePath.split('/').pop(),
      });
    }
  }
  
  return routes;
}

function isSafeEndpoint(method, path) {
  if (method === 'GET') {
    return true; // Most GET endpoints are safe
  }
  
  const signature = `${method} ${path}`;
  return SAFE_PATTERNS.some(pattern => pattern.test(signature));
}

function shouldHaveConfirmGate(method, path) {
  return SENSITIVE_METHODS.includes(method) && !isSafeEndpoint(method, path);
}

function scanRoutes() {
  console.log('🔍 ConfirmGate Security Scan');
  console.log('============================');
  
  if (!fs.existsSync(ROUTES_DIR)) {
    console.error(`❌ Routes directory not found: ${ROUTES_DIR}`);
    return false;
  }
  
  const routeFiles = fs.readdirSync(ROUTES_DIR)
    .filter(file => file.endsWith('.ts') || file.endsWith('.js'))
    .map(file => path.join(ROUTES_DIR, file));
  
  console.log(`📁 Scanning ${routeFiles.length} route files...\n`);
  
  let allRoutes = [];
  let vulnerableRoutes = [];
  let protectedRoutes = [];
  let safeRoutes = [];
  
  // Extract routes from all files
  for (const filePath of routeFiles) {
    const routes = extractRoutes(filePath);
    allRoutes = allRoutes.concat(routes);
  }
  
  // Analyze each route
  for (const route of allRoutes) {
    if (shouldHaveConfirmGate(route.method, route.path)) {
      if (route.hasConfirmGate) {
        protectedRoutes.push(route);
      } else {
        vulnerableRoutes.push(route);
      }
    } else {
      safeRoutes.push(route);
    }
  }
  
  // Report results
  console.log('📊 Scan Results:');
  console.log(`Total routes found: ${allRoutes.length}`);
  console.log(`✅ Protected routes: ${protectedRoutes.length}`);
  console.log(`⚠️  Safe routes (no protection needed): ${safeRoutes.length}`);
  console.log(`❌ Vulnerable routes: ${vulnerableRoutes.length}\n`);
  
  // Show protected routes
  if (protectedRoutes.length > 0) {
    console.log('✅ PROTECTED ROUTES (with confirmGate):');
    for (const route of protectedRoutes) {
      console.log(`   ${route.method} ${route.path} (${route.file}:${route.line})`);
    }
    console.log();
  }
  
  // Show safe routes summary
  if (safeRoutes.length > 0) {
    console.log('⚠️  SAFE ROUTES (no confirmGate needed):');
    const grouped = {};
    for (const route of safeRoutes) {
      const key = route.file;
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(route);
    }
    
    for (const [file, routes] of Object.entries(grouped)) {
      console.log(`   ${file}: ${routes.length} safe routes`);
    }
    console.log();
  }
  
  // Show vulnerable routes (these need to be fixed)
  if (vulnerableRoutes.length > 0) {
    console.log('❌ VULNERABLE ROUTES (missing confirmGate):');
    for (const route of vulnerableRoutes) {
      console.log(`   ${route.method} ${route.path} (${route.file}:${route.line})`);
      console.log(`      Code: ${route.raw}`);
    }
    console.log();
  }
  
  // Import check
  console.log('🔍 Checking confirmGate imports...');
  let missingImports = [];
  
  for (const filePath of routeFiles) {
    const content = fs.readFileSync(filePath, 'utf8');
    const hasConfirmGateUsage = content.includes('confirmGate');
    const hasConfirmGateImport = content.includes('from \'../middleware/confirmGate.js\'') || 
                                 content.includes('from "../middleware/confirmGate.js"') ||
                                 content.includes('require(\'../middleware/confirmGate') ||
                                 content.includes('require("../middleware/confirmGate');
    
    if (hasConfirmGateUsage && !hasConfirmGateImport) {
      missingImports.push(filePath.split('/').pop());
    }
  }
  
  if (missingImports.length > 0) {
    console.log('❌ Files using confirmGate without proper import:');
    missingImports.forEach(file => console.log(`   ${file}`));
  } else {
    console.log('✅ All confirmGate imports are properly declared');
  }
  
  console.log('\n============================');
  
  if (vulnerableRoutes.length === 0 && missingImports.length === 0) {
    console.log('🎉 SECURITY SCAN PASSED');
    console.log('All sensitive routes are properly protected with confirmGate middleware.');
    return true;
  } else {
    console.log('⚠️  SECURITY ISSUES FOUND');
    console.log('Please fix the vulnerable routes and missing imports listed above.');
    return false;
  }
}

// Run scan if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const success = scanRoutes();
  process.exit(success ? 0 : 1);
}

export { scanRoutes };