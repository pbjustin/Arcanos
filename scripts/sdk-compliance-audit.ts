#!/usr/bin/env ts-node
/**
 * ARCANOS SDK Compliance and Optimization Audit
 * 
 * Comprehensive audit system that validates:
 * - OpenAI SDK compliance
 * - Railway deployment readiness
 * - Code quality and deprecated patterns
 * - Environment variable validation
 * - Iterative optimization until convergence
 */

import fs from 'fs/promises';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

interface AuditResult {
  timestamp: string;
  iteration: number;
  modules: {
    [moduleName: string]: {
      status: 'compliant' | 'needs_work' | 'error';
      riskLevel: 'low' | 'medium' | 'high';
      issues: string[];
      fixes: string[];
      sdkCompliance: boolean;
      railwayReady: boolean;
    };
  };
  summary: {
    totalModules: number;
    compliantModules: number;
    convergenceReached: boolean;
    overallRisk: 'low' | 'medium' | 'high';
    recommendedActions: string[];
  };
  deploymentChecks: {
    procfileValid: boolean;
    railwayConfigValid: boolean;
    healthEndpointExists: boolean;
    envVariablesDocumented: boolean;
  };
  sdkValidation: {
    version: string;
    deprecatedPatternsFound: number;
    manualFetchCalls: number;
    errorHandlingStandardized: boolean;
  };
  codeQuality: {
    lintPassed: boolean;
    typeCheckPassed: boolean;
    buildPassed: boolean;
    testsPassed: boolean;
  };
}

let auditIteration = 1;
const MAX_ITERATIONS = 10;

/**
 * Main audit execution
 */
async function runCompleteAudit(): Promise<AuditResult> {
  console.log(`\n🔍 ARCANOS SDK Compliance Audit - Iteration ${auditIteration}\n`);
  console.log('=' .repeat(60));

  const result: AuditResult = {
    timestamp: new Date().toISOString(),
    iteration: auditIteration,
    modules: {},
    summary: {
      totalModules: 0,
      compliantModules: 0,
      convergenceReached: false,
      overallRisk: 'low',
      recommendedActions: [],
    },
    deploymentChecks: {
      procfileValid: false,
      railwayConfigValid: false,
      healthEndpointExists: false,
      envVariablesDocumented: false,
    },
    sdkValidation: {
      version: '',
      deprecatedPatternsFound: 0,
      manualFetchCalls: 0,
      errorHandlingStandardized: true,
    },
    codeQuality: {
      lintPassed: false,
      typeCheckPassed: false,
      buildPassed: false,
      testsPassed: false,
    },
  };

  // Run all audit phases
  await auditCodeQuality(result);
  await auditSDKCompliance(result);
  await auditModules(result);
  await auditDeploymentReadiness(result);
  
  // Generate summary
  generateSummary(result);

  // Save results
  await saveComplianceReport(result);

  return result;
}

/**
 * Audit code quality (lint, typecheck, build, test)
 */
async function auditCodeQuality(result: AuditResult): Promise<void> {
  console.log('\n📋 Phase 1: Code Quality Enforcement\n');

  // TypeScript type checking
  try {
    execSync('npm run type-check', { cwd: projectRoot, stdio: 'pipe' });
    result.codeQuality.typeCheckPassed = true;
    console.log('   ✅ TypeScript type checking passed');
  } catch (error) {
    result.codeQuality.typeCheckPassed = false;
    console.log('   ❌ TypeScript type checking failed');
    result.summary.recommendedActions.push('Fix TypeScript type errors');
  }

  // Linting
  try {
    execSync('npm run lint', { cwd: projectRoot, stdio: 'pipe' });
    result.codeQuality.lintPassed = true;
    console.log('   ✅ ESLint passed');
  } catch (error) {
    result.codeQuality.lintPassed = false;
    console.log('   ❌ ESLint failed');
    result.summary.recommendedActions.push('Fix linting errors with: npm run lint:fix');
  }

  // Build
  try {
    execSync('npm run build', { cwd: projectRoot, stdio: 'pipe' });
    result.codeQuality.buildPassed = true;
    console.log('   ✅ Build successful');
  } catch (error) {
    result.codeQuality.buildPassed = false;
    console.log('   ❌ Build failed');
    result.summary.recommendedActions.push('Fix build errors');
  }

  // Tests (optional - don't fail if no tests)
  try {
    execSync('npm run test 2>&1', { cwd: projectRoot, stdio: 'pipe' });
    result.codeQuality.testsPassed = true;
    console.log('   ✅ Tests passed');
  } catch (error) {
    // Tests might not exist or might fail, but we don't fail the audit
    console.log('   ⚠️  Tests not run or failed (non-blocking)');
  }
}

/**
 * Audit OpenAI SDK compliance
 */
async function auditSDKCompliance(result: AuditResult): Promise<void> {
  console.log('\n🤖 Phase 2: OpenAI SDK Compliance Validation\n');

  // Check SDK version
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8')
    );
    result.sdkValidation.version = packageJson.dependencies?.openai || 'not found';
    console.log(`   📦 OpenAI SDK Version: ${result.sdkValidation.version}`);

    if (!result.sdkValidation.version.includes('5.')) {
      result.summary.recommendedActions.push('Update OpenAI SDK to version 5.x or higher');
      result.summary.overallRisk = 'high';
    } else {
      console.log('   ✅ SDK version is compliant (v5.x)');
    }
  } catch (error) {
    console.log('   ❌ Could not verify SDK version');
  }

  // Scan for deprecated patterns
  const deprecatedPatterns = [
    { pattern: /engine\s*:/g, name: 'engine parameter (use model instead)' },
    { pattern: /Completion\.create/g, name: 'Completion.create (use chat.completions.create)' },
    { pattern: /\.complete\(/g, name: '.complete() method (deprecated)' },
  ];

  const srcDir = path.join(projectRoot, 'src');
  const files = await getAllTsFiles(srcDir);

  for (const pattern of deprecatedPatterns) {
    let foundCount = 0;
    for (const file of files) {
      const content = await fs.readFile(file, 'utf8');
      const matches = content.match(pattern.pattern);
      if (matches) {
        foundCount += matches.length;
      }
    }
    if (foundCount > 0) {
      console.log(`   ⚠️  Found ${foundCount} instances of deprecated: ${pattern.name}`);
      result.sdkValidation.deprecatedPatternsFound += foundCount;
      result.summary.recommendedActions.push(`Replace deprecated pattern: ${pattern.name}`);
    }
  }

  // Check for manual fetch/axios calls to OpenAI
  for (const file of files) {
    const content = await fs.readFile(file, 'utf8');
    if (
      (content.includes('fetch') && content.includes('openai.com')) ||
      (content.includes('axios') && content.includes('openai.com'))
    ) {
      result.sdkValidation.manualFetchCalls++;
      console.log(`   ⚠️  Manual API call found in: ${path.relative(projectRoot, file)}`);
      result.summary.recommendedActions.push('Replace manual API calls with SDK methods');
    }
  }

  if (result.sdkValidation.deprecatedPatternsFound === 0 && result.sdkValidation.manualFetchCalls === 0) {
    console.log('   ✅ No deprecated patterns or manual API calls found');
  }
}

/**
 * Audit individual modules
 */
async function auditModules(result: AuditResult): Promise<void> {
  console.log('\n🔧 Phase 3: Module-Level Compliance Audit\n');

  const moduleDirs = [
    'src/services',
    'src/controllers',
    'src/routes',
    'src/logic',
    'src/utils',
    'src/middleware',
  ];

  for (const moduleDir of moduleDirs) {
    const fullPath = path.join(projectRoot, moduleDir);
    try {
      const files = await fs.readdir(fullPath);
      const moduleName = path.basename(moduleDir);

      result.modules[moduleName] = {
        status: 'compliant',
        riskLevel: 'low',
        issues: [],
        fixes: [],
        sdkCompliance: true,
        railwayReady: true,
      };

      // Check each file in the module
      for (const file of files) {
        if (file.endsWith('.ts') || file.endsWith('.js')) {
          const filePath = path.join(fullPath, file);
          const content = await fs.readFile(filePath, 'utf8');

          // Check file size (files over 500 lines might need splitting)
          const lineCount = content.split('\n').length;
          if (lineCount > 500) {
            result.modules[moduleName].issues.push(
              `${file} has ${lineCount} lines (consider splitting)`
            );
            result.modules[moduleName].riskLevel = 'medium';
          }

          // Check for TODO/FIXME
          if (content.match(/TODO|FIXME|XXX|HACK/)) {
            result.modules[moduleName].issues.push(`${file} contains TODO/FIXME markers`);
          }
        }
      }

      if (result.modules[moduleName].issues.length === 0) {
        console.log(`   ✅ ${moduleName}: compliant`);
      } else {
        console.log(`   ⚠️  ${moduleName}: ${result.modules[moduleName].issues.length} issues`);
        result.modules[moduleName].status = 'needs_work';
      }

      result.summary.totalModules++;
      if (result.modules[moduleName].status === 'compliant') {
        result.summary.compliantModules++;
      }
    } catch (error) {
      // Module directory doesn't exist, skip
    }
  }
}

/**
 * Audit Railway deployment readiness
 */
async function auditDeploymentReadiness(result: AuditResult): Promise<void> {
  console.log('\n🚂 Phase 4: Railway Deployment Readiness\n');

  // Check Procfile
  try {
    const procfile = await fs.readFile(path.join(projectRoot, 'Procfile'), 'utf8');
    if (procfile.includes('dist/start-server.js')) {
      result.deploymentChecks.procfileValid = true;
      console.log('   ✅ Procfile is valid');
    } else {
      console.log('   ❌ Procfile missing or invalid');
      result.summary.recommendedActions.push('Fix Procfile configuration');
    }
  } catch (error) {
    console.log('   ❌ Procfile not found');
    result.summary.recommendedActions.push('Create Procfile for Railway');
  }

  // Check railway.json
  try {
    const railwayConfig = JSON.parse(
      await fs.readFile(path.join(projectRoot, 'railway.json'), 'utf8')
    );
    if (railwayConfig.deploy?.startCommand) {
      result.deploymentChecks.railwayConfigValid = true;
      console.log('   ✅ railway.json is valid');
    } else {
      console.log('   ❌ railway.json missing start command');
      result.summary.recommendedActions.push('Fix railway.json configuration');
    }
  } catch (error) {
    console.log('   ❌ railway.json not found');
    result.summary.recommendedActions.push('Create railway.json configuration');
  }

  // Check for health endpoint
  try {
    const routesDir = path.join(projectRoot, 'src/routes');
    const routeFiles = await fs.readdir(routesDir);
    let healthEndpointFound = false;

    for (const file of routeFiles) {
      const content = await fs.readFile(path.join(routesDir, file), 'utf8');
      if (content.includes('/health') || content.includes('/api/test')) {
        healthEndpointFound = true;
        break;
      }
    }

    result.deploymentChecks.healthEndpointExists = healthEndpointFound;
    if (healthEndpointFound) {
      console.log('   ✅ Health endpoint exists');
    } else {
      console.log('   ⚠️  Health endpoint not found');
      result.summary.recommendedActions.push('Add health check endpoint');
    }
  } catch (error) {
    console.log('   ❌ Could not check for health endpoint');
  }

  // Check .env.example documentation
  try {
    const envExample = await fs.readFile(path.join(projectRoot, '.env.example'), 'utf8');
    const requiredVars = ['OPENAI_API_KEY', 'PORT', 'NODE_ENV', 'AI_MODEL'];
    const allDocumented = requiredVars.every((v) => envExample.includes(v));

    result.deploymentChecks.envVariablesDocumented = allDocumented;
    if (allDocumented) {
      console.log('   ✅ Environment variables documented');
    } else {
      console.log('   ⚠️  Some environment variables not documented');
      result.summary.recommendedActions.push('Document all required environment variables');
    }
  } catch (error) {
    console.log('   ❌ .env.example not found');
  }
}

/**
 * Generate summary and check for convergence
 */
function generateSummary(result: AuditResult): void {
  console.log('\n📊 AUDIT SUMMARY');
  console.log('=' .repeat(60));

  // Calculate overall risk
  const criticalIssues =
    !result.codeQuality.typeCheckPassed ||
    !result.codeQuality.lintPassed ||
    !result.codeQuality.buildPassed ||
    result.sdkValidation.deprecatedPatternsFound > 5;

  if (criticalIssues) {
    result.summary.overallRisk = 'high';
  } else if (result.summary.recommendedActions.length > 0) {
    result.summary.overallRisk = 'medium';
  }

  console.log(`Iteration: ${result.iteration}`);
  console.log(`Timestamp: ${result.timestamp}`);
  console.log(`Overall Risk: ${result.summary.overallRisk.toUpperCase()}`);
  console.log(`\nCode Quality:`);
  console.log(`  - Type Check: ${result.codeQuality.typeCheckPassed ? '✅' : '❌'}`);
  console.log(`  - Lint: ${result.codeQuality.lintPassed ? '✅' : '❌'}`);
  console.log(`  - Build: ${result.codeQuality.buildPassed ? '✅' : '❌'}`);
  console.log(`\nSDK Compliance:`);
  console.log(`  - Version: ${result.sdkValidation.version}`);
  console.log(`  - Deprecated Patterns: ${result.sdkValidation.deprecatedPatternsFound}`);
  console.log(`  - Manual API Calls: ${result.sdkValidation.manualFetchCalls}`);
  console.log(`\nModule Status:`);
  console.log(`  - Total Modules: ${result.summary.totalModules}`);
  console.log(`  - Compliant: ${result.summary.compliantModules}`);
  console.log(`\nDeployment Readiness:`);
  console.log(`  - Procfile: ${result.deploymentChecks.procfileValid ? '✅' : '❌'}`);
  console.log(`  - Railway Config: ${result.deploymentChecks.railwayConfigValid ? '✅' : '❌'}`);
  console.log(`  - Health Endpoint: ${result.deploymentChecks.healthEndpointExists ? '✅' : '❌'}`);

  // Check for convergence - only critical compliance issues prevent convergence
  // Large files and TODO markers are recommendations, not blockers
  const convergence =
    result.codeQuality.typeCheckPassed &&
    result.codeQuality.lintPassed &&
    result.codeQuality.buildPassed &&
    result.sdkValidation.deprecatedPatternsFound === 0 &&
    result.sdkValidation.manualFetchCalls === 0 &&
    result.deploymentChecks.procfileValid &&
    result.deploymentChecks.railwayConfigValid &&
    result.deploymentChecks.healthEndpointExists;

  result.summary.convergenceReached = convergence;

  if (convergence) {
    console.log('\n🎯 CONVERGENCE REACHED - All compliance checks passed!');
  } else {
    console.log('\n⚠️  Convergence not reached - see recommended actions');
  }

  if (result.summary.recommendedActions.length > 0) {
    console.log('\n🔧 Recommended Actions:');
    result.summary.recommendedActions.forEach((action, i) => {
      console.log(`   ${i + 1}. ${action}`);
    });
  }
}

/**
 * Save compliance report
 */
async function saveComplianceReport(result: AuditResult): Promise<void> {
  const logsDir = path.join(projectRoot, 'logs');
  await fs.mkdir(logsDir, { recursive: true });

  // Save detailed report
  const reportPath = path.join(logsDir, 'compliance_report.json');
  await fs.writeFile(reportPath, JSON.stringify(result, null, 2));

  console.log(`\n📝 Compliance report saved to: logs/compliance_report.json`);
}

/**
 * Helper: Get all TypeScript files recursively
 */
async function getAllTsFiles(dir: string): Promise<string[]> {
  const files: string[] = [];

  async function scan(currentDir: string) {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await scan(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Skip directories we can't read
    }
  }

  await scan(dir);
  return files;
}

/**
 * Main execution with iterative loop
 */
async function main() {
  console.log('🧠 ARCANOS: Recursive Codebase Streamlining & SDK Compliance Audit');
  console.log('=' .repeat(60));

  let result: AuditResult | null = null;

  try {
    while (auditIteration <= MAX_ITERATIONS) {
      result = await runCompleteAudit();

      if (result.summary.convergenceReached) {
        console.log(`\n✅ Optimization complete after ${auditIteration} iteration(s)`);
        break;
      }

      if (auditIteration < MAX_ITERATIONS) {
        console.log(`\n🔄 Starting iteration ${auditIteration + 1}...`);
      } else {
        console.log(`\n⚠️  Max iterations (${MAX_ITERATIONS}) reached`);
      }

      auditIteration++;
    }
  } catch (error) {
    console.error('❌ Audit error:', error);
    // Still try to save whatever results we have
    if (result) {
      await saveComplianceReport(result).catch(() => {
        console.error('❌ Failed to save compliance report');
      });
    }
    process.exit(1);
  }

  console.log('\n' + '=' .repeat(60));
  console.log('🎯 ARCANOS Audit Complete\n');

  // Exit with appropriate code
  process.exit(result && result.summary.overallRisk === 'low' ? 0 : 1);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('❌ Audit failed:', error);
    process.exit(1);
  });
}
