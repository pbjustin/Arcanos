#!/usr/bin/env node

/**
 * ARCANOS Continuous Audit Script
 * 
 * Implements automated codebase auditing and refinement according to:
 * 1. Prune Aggressively, Safely
 * 2. Preserve Architectural Integrity
 * 3. Enforce OpenAI SDK Compatibility
 * 4. Optimize for Railway Deployment
 * 5. Loop Until Clean
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

console.log('🔍 ARCANOS Continuous Audit Starting...\n');

let auditResults = {
  timestamp: new Date().toISOString(),
  phase1: { status: '✅', issues: [], actions: [] },
  phase2: { status: '✅', issues: [], actions: [] },
  phase3: { status: '✅', issues: [], actions: [] },
  phase4: { status: '✅', issues: [], actions: [] },
  summary: { totalIssues: 0, criticalIssues: 0, recommendedActions: [] }
};

/**
 * Phase 1: Prune Aggressively, Safely
 */
async function auditPhase1() {
  console.log('📋 Phase 1: Prune Aggressively, Safely');
  
  try {
    // Check for unused dependencies
    try {
      const depcheckOutput = execSync('npx depcheck --ignores=typescript,@types/*,eslint,jest', 
        { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe' });
      
      if (depcheckOutput.includes('Unused dependencies')) {
        auditResults.phase1.issues.push('Unused dependencies detected');
        auditResults.phase1.actions.push('Run: npm uninstall <unused-deps>');
        auditResults.phase1.status = '⚠️';
      }
    } catch (depcheckError) {
      // Depcheck not available or failed, skip this check
      console.log('   ⚠️ Skipping dependency check (depcheck not available)');
    }

    // Check for security vulnerabilities
    try {
      execSync('npm audit --audit-level=high', { cwd: projectRoot, stdio: 'pipe' });
    } catch (error) {
      auditResults.phase1.issues.push('Security vulnerabilities detected');
      auditResults.phase1.actions.push('Run: npm audit fix');
      auditResults.phase1.status = '❌';
    }

    // Check for large files that might need splitting
    const srcDir = path.join(projectRoot, 'src');
    const files = await findLargeFiles(srcDir, 1000); // Files > 1000 lines
    if (files.length > 0) {
      auditResults.phase1.issues.push(`Large files detected: ${files.map(f => f.name).join(', ')}`);
      auditResults.phase1.actions.push('Consider splitting large files into modules');
      auditResults.phase1.status = '⚠️';
    }

    console.log(`   ${auditResults.phase1.status} Phase 1 Complete`);
  } catch (error) {
    auditResults.phase1.status = '❌';
    auditResults.phase1.issues.push(`Audit error: ${error.message}`);
    console.log(`   ❌ Phase 1 Failed: ${error.message}`);
  }
}

/**
 * Phase 2: Preserve Architectural Integrity
 */
async function auditPhase2() {
  console.log('🏗️  Phase 2: Preserve Architectural Integrity');
  
  try {
    // Check for duplicate patterns
    const duplicates = await findDuplicatePatterns();
    if (duplicates.length > 0) {
      auditResults.phase2.issues.push(`Duplicate patterns detected: ${duplicates.length} instances`);
      auditResults.phase2.actions.push('Consolidate duplicate logic patterns');
      auditResults.phase2.status = '⚠️';
    }

    // Check module boundaries
    const crossModuleImports = await checkCrossModuleImports();
    if (crossModuleImports.violations > 0) {
      auditResults.phase2.issues.push(`Module boundary violations: ${crossModuleImports.violations}`);
      auditResults.phase2.actions.push('Review and clean up cross-module dependencies');
      auditResults.phase2.status = '⚠️';
    }

    console.log(`   ${auditResults.phase2.status} Phase 2 Complete`);
  } catch (error) {
    auditResults.phase2.status = '❌';
    auditResults.phase2.issues.push(`Architecture audit error: ${error.message}`);
    console.log(`   ❌ Phase 2 Failed: ${error.message}`);
  }
}

/**
 * Phase 3: Enforce OpenAI SDK Compatibility
 */
async function auditPhase3() {
  console.log('🤖 Phase 3: Enforce OpenAI SDK Compatibility');
  
  try {
    // Check OpenAI SDK version
    const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
    const openaiVersion = packageJson.dependencies?.openai;
    
    // Extract version number (e.g., "^6.9.1" -> 6)
    const versionMatch = openaiVersion?.match(/(\d+)\./);
    const majorVersion = versionMatch ? parseInt(versionMatch[1]) : 0;
    
    if (!openaiVersion || majorVersion < 5) {
      auditResults.phase3.issues.push(`OpenAI SDK version may be outdated: ${openaiVersion}`);
      auditResults.phase3.actions.push('Update to OpenAI SDK ≥5.15.0 (latest: 6.x)');
      auditResults.phase3.status = '⚠️';
    } else if (majorVersion >= 6) {
      // Version 6.x is the latest - all good!
      auditResults.phase3.actions.push('✅ OpenAI SDK is up to date (v6.x)');
    }

    // Check for deprecated patterns
    const deprecatedPatterns = await findDeprecatedOpenAIPatterns();
    if (deprecatedPatterns.length > 0) {
      auditResults.phase3.issues.push(`Deprecated OpenAI patterns: ${deprecatedPatterns.length} instances`);
      auditResults.phase3.actions.push('Update deprecated API usage patterns');
      auditResults.phase3.status = '⚠️';
    }

    console.log(`   ${auditResults.phase3.status} Phase 3 Complete`);
  } catch (error) {
    auditResults.phase3.status = '❌';
    auditResults.phase3.issues.push(`OpenAI audit error: ${error.message}`);
    console.log(`   ❌ Phase 3 Failed: ${error.message}`);
  }
}

/**
 * Phase 4: Optimize for Railway Deployment
 */
async function auditPhase4() {
  console.log('🚂 Phase 4: Optimize for Railway Deployment');
  
  try {
    // Check Dockerfile optimization
    const dockerfile = await fs.readFile(path.join(projectRoot, 'Dockerfile'), 'utf8');
    if (!dockerfile.includes('--max-old-space-size')) {
      auditResults.phase4.issues.push('Dockerfile missing memory optimization');
      auditResults.phase4.actions.push('Add Node.js memory optimization flags');
      auditResults.phase4.status = '⚠️';
    }

    // Check environment variable schema
    const envExample = await fs.readFile(path.join(projectRoot, '.env.example'), 'utf8');
    const requiredVars = ['NODE_ENV', 'PORT', 'OPENAI_API_KEY'];
    for (const varName of requiredVars) {
      if (!envExample.includes(varName)) {
        auditResults.phase4.issues.push(`Missing required env var documentation: ${varName}`);
        auditResults.phase4.actions.push('Update .env.example with required variables');
        auditResults.phase4.status = '⚠️';
      }
    }

    // Check health check endpoint
    const registerFile = await fs.readFile(path.join(projectRoot, 'src/routes/register.ts'), 'utf8');
    if (!registerFile.includes('/api/test')) {
      auditResults.phase4.issues.push('Missing health check endpoint');
      auditResults.phase4.actions.push('Add /api/test endpoint for Railway health checks');
      auditResults.phase4.status = '⚠️';
    }

    console.log(`   ${auditResults.phase4.status} Phase 4 Complete`);
  } catch (error) {
    auditResults.phase4.status = '❌';
    auditResults.phase4.issues.push(`Railway audit error: ${error.message}`);
    console.log(`   ❌ Phase 4 Failed: ${error.message}`);
  }
}

/**
 * Helper function to find large files
 */
async function findLargeFiles(dir, maxLines) {
  const largeFiles = [];
  
  async function scanDir(currentDir) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        await scanDir(fullPath);
      } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
        const content = await fs.readFile(fullPath, 'utf8');
        const lineCount = content.split('\n').length;
        
        if (lineCount > maxLines) {
          largeFiles.push({
            name: path.relative(projectRoot, fullPath),
            lines: lineCount
          });
        }
      }
    }
  }
  
  await scanDir(dir);
  return largeFiles;
}

/**
 * Helper function to find duplicate patterns
 */
async function findDuplicatePatterns() {
  // Simple heuristic: look for similar function names or similar imports
  const duplicates = [];
  
  try {
    const srcFiles = await fs.readdir(path.join(projectRoot, 'src'), { recursive: true });
    const patterns = new Map();
    
    for (const file of srcFiles) {
      if (typeof file === 'string' && file.endsWith('.ts')) {
        try {
          const content = await fs.readFile(path.join(projectRoot, 'src', file), 'utf8');
          
          // Look for export patterns
          const exports = content.match(/export\s+(function|class|const)\s+(\w+)/g) || [];
          for (const exp of exports) {
            const name = exp.split(/\s+/).pop();
            if (patterns.has(name)) {
              duplicates.push(`Duplicate export: ${name} in ${file} and ${patterns.get(name)}`);
            } else {
              patterns.set(name, file);
            }
          }
        } catch (err) {
          // Skip files that can't be read
        }
      }
    }
  } catch (error) {
    console.warn('Could not scan for duplicate patterns:', error.message);
  }
  
  return duplicates;
}

/**
 * Helper function to check cross-module imports
 */
async function checkCrossModuleImports() {
  let violations = 0;
  
  try {
    // Simple check: services shouldn't import from routes, routes shouldn't import from logic deeply
    const srcDir = path.join(projectRoot, 'src');
    const files = await fs.readdir(srcDir, { recursive: true });
    
    for (const file of files) {
      if (typeof file === 'string' && file.endsWith('.ts')) {
        try {
          const content = await fs.readFile(path.join(srcDir, file), 'utf8');
          const imports = content.match(/import\s+.+\s+from\s+['"]([^'"]+)['"]/g) || [];
          
          for (const imp of imports) {
            const importPath = imp.match(/from\s+['"]([^'"]+)['"]/)?.[1];
            if (importPath && importPath.startsWith('../')) {
              // Count relative imports that go up multiple levels as potential violations
              const levels = (importPath.match(/\.\.\//g) || []).length;
              if (levels > 2) {
                violations++;
              }
            }
          }
        } catch (err) {
          // Skip files that can't be read
        }
      }
    }
  } catch (error) {
    console.warn('Could not check cross-module imports:', error.message);
  }
  
  return { violations };
}

/**
 * Helper function to find deprecated OpenAI patterns
 */
async function findDeprecatedOpenAIPatterns() {
  const deprecated = [];
  const patterns = [
    /engine\s*:/g,
    /Completion\.create/g,
    /\.complete\(/g
  ];
  
  try {
    const srcFiles = await fs.readdir(path.join(projectRoot, 'src'), { recursive: true });
    
    for (const file of srcFiles) {
      if (typeof file === 'string' && file.endsWith('.ts')) {
        try {
          const content = await fs.readFile(path.join(projectRoot, 'src', file), 'utf8');
          
          for (const pattern of patterns) {
            if (pattern.test(content)) {
              deprecated.push(`Deprecated pattern in ${file}`);
            }
          }
        } catch (err) {
          // Skip files that can't be read
        }
      }
    }
  } catch (error) {
    console.warn('Could not scan for deprecated patterns:', error.message);
  }
  
  return deprecated;
}

/**
 * Generate summary and recommendations
 */
function generateSummary() {
  const allPhases = [auditResults.phase1, auditResults.phase2, auditResults.phase3, auditResults.phase4];
  
  auditResults.summary.totalIssues = allPhases.reduce((sum, phase) => sum + phase.issues.length, 0);
  auditResults.summary.criticalIssues = allPhases.filter(phase => phase.status === '❌').length;
  
  // Collect all actions
  auditResults.summary.recommendedActions = allPhases.flatMap(phase => phase.actions);
  
  console.log('\n📊 AUDIT SUMMARY');
  console.log('================');
  console.log(`Total Issues: ${auditResults.summary.totalIssues}`);
  console.log(`Critical Issues: ${auditResults.summary.criticalIssues}`);
  console.log(`Overall Status: ${auditResults.summary.criticalIssues === 0 ? 
    (auditResults.summary.totalIssues === 0 ? '✅ CLEAN' : '⚠️ NEEDS ATTENTION') : 
    '❌ CRITICAL ISSUES'}`);
  
  if (auditResults.summary.recommendedActions.length > 0) {
    console.log('\n🔧 RECOMMENDED ACTIONS:');
    auditResults.summary.recommendedActions.forEach((action, i) => {
      console.log(`${i + 1}. ${action}`);
    });
  }
}

/**
 * Save audit results to file
 */
async function saveAuditResults() {
  const auditDir = path.join(projectRoot, 'logs');
  await fs.mkdir(auditDir, { recursive: true });
  
  const auditFile = path.join(auditDir, `audit-${Date.now()}.json`);
  await fs.writeFile(auditFile, JSON.stringify(auditResults, null, 2));
  
  console.log(`\n📝 Audit results saved to: ${path.relative(projectRoot, auditFile)}`);
}

/**
 * Main audit execution
 */
async function runAudit() {
  try {
    await auditPhase1();
    await auditPhase2();
    await auditPhase3();
    await auditPhase4();
    
    generateSummary();
    await saveAuditResults();
    
    console.log('\n🎯 ARCANOS Continuous Audit Complete');
    
    // Exit with appropriate code
    process.exit(auditResults.summary.criticalIssues > 0 ? 1 : 0);
    
  } catch (error) {
    console.error('❌ Audit failed:', error);
    process.exit(1);
  }
}

// Run the audit
runAudit();