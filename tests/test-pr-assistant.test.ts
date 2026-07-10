/**
 * Tests for ARCANOS PR Assistant
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import fs from 'fs/promises';
import path from 'path';

const runCommandMock = jest.fn();

jest.unstable_mockModule('../src/services/prAssistant/commandUtils.js', () => ({
  runCommand: runCommandMock
}));

const { PRAssistant } = await import('../src/services/prAssistant.js');

// Mock test data
const mockPRDiff = `
diff --git a/src/test.ts b/src/test.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/test.ts
@@ -0,0 +1,10 @@
+import { someFunction } from './utils';
+
+export function testFunction() {
+  return someFunction();
+}
+
+// Add proper error handling
+console.log('Test output');
`;

const mockPRFiles = ['src/test.ts', 'package.json'];

const mockLargeDiff = `
diff --git a/src/large.ts b/src/large.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/large.ts
@@ -0,0 +1,600 @@
` + Array.from({ length: 600 }, (_, i) => `+line ${i}`).join('\n');

const mockBadDiff = `
diff --git a/src/bad.ts b/src/bad.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/bad.ts
@@ -0,0 +1,10 @@
+// TODO: Fix this later
+console.log('debug info');
+console.error('error info');
+console.warn('warning info');
+console.debug('debug info');
+
+const apiKey = 'sk-1234567890abcdef';
+const port = 3000;
+const url = 'https://api.example.com';
`;

describe('ARCANOS PR Assistant', () => {
  let prAssistant: PRAssistant;
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for testing
    tempDir = path.join('/tmp', `pr-test-${Date.now()}`);
    await fs.mkdir(tempDir, { recursive: true });
    
    // Create mock package.json
    const packageJson = {
      name: 'test-project',
      dependencies: {
        openai: '^6.22.0'
      }
    };
    await fs.writeFile(
      path.join(tempDir, 'package.json'), 
      JSON.stringify(packageJson, null, 2)
    );

    // Create mock .env.example
    await fs.writeFile(
      path.join(tempDir, '.env.example'),
      'PORT=8080\nOPENAI_API_KEY=your_key_here\n'
    );

    runCommandMock.mockResolvedValue({ stdout: 'PASS', stderr: '' });

    prAssistant = new PRAssistant(tempDir);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
    runCommandMock.mockReset();
  });

  describe('Dead Code Removal Check', () => {
    it('should pass for clean code', async () => {
      const result = await prAssistant['checkDeadCodeRemoval'](mockPRFiles, mockPRDiff);
      
      expect(result.status).toBe('✅');
      expect(result.message).toBe('No bloated or dead code detected');
      expect(result.details).toEqual(['PR maintains clean codebase standards']);
    });

    it('does not treat ordinary distinct added lines as code duplication', async () => {
      const distinctLinesDiff = [
        'diff --git a/src/distinct.ts b/src/distinct.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/src/distinct.ts',
        '@@ -0,0 +1,8 @@',
        '+const alphaResult = buildAlphaResult();',
        '+const betaResult = buildBetaResult();',
        '+const gammaResult = buildGammaResult();',
        '+const deltaResult = buildDeltaResult();',
        '+const epsilonResult = buildEpsilonResult();',
        '+const zetaResult = buildZetaResult();',
        '+const etaResult = buildEtaResult();',
        '+export const results = [alphaResult, betaResult, gammaResult, deltaResult];'
      ].join('\n');

      const result = await prAssistant['checkDeadCodeRemoval'](['src/distinct.ts'], distinctLinesDiff);

      expect(result.status).toBe('✅');
      expect(result.details).toEqual(['PR maintains clean codebase standards']);
    });

    it('should detect large files', async () => {
      // Create src directory first
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      
      // Create a large file
      const largeContent = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
      await fs.writeFile(path.join(tempDir, 'src', 'large.ts'), largeContent);
      
      const result = await prAssistant['checkDeadCodeRemoval'](['src/large.ts'], mockLargeDiff);
      
      expect(result.details).toContain('Consider breaking down src/large.ts into smaller, focused modules');
    });

    it('does not reject a pre-existing large file for a small scoped edit', async () => {
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, 'src', 'existing-large.ts'),
        Array.from({ length: 600 }, (_, index) => `export const value${index} = ${index};`).join('\n')
      );

      const smallEditDiff = [
        'diff --git a/src/existing-large.ts b/src/existing-large.ts',
        'index 1111111..2222222 100644',
        '--- a/src/existing-large.ts',
        '+++ b/src/existing-large.ts',
        '@@ -1,3 +1,4 @@',
        '+export const scopedChange = true;',
        ' export const value0 = 0;',
        ' export const value1 = 1;',
        ' export const value2 = 2;'
      ].join('\n');

      const result = await prAssistant['checkDeadCodeRemoval'](
        ['src/existing-large.ts'],
        smallEditDiff
      );

      expect(result.status).toBe('✅');
      expect(result.details).toEqual(['PR maintains clean codebase standards']);
    });

    it('keeps two large-file findings advisory', async () => {
      await fs.mkdir(path.join(tempDir, 'src'), { recursive: true });

      const largeFiles = ['src/first-large.ts', 'src/second-large.ts'];
      for (const file of largeFiles) {
        await fs.writeFile(
          path.join(tempDir, file),
          Array.from({ length: 501 }, (_, index) => `export const value${index} = ${index};`).join('\n')
        );
      }

      const largeFilesDiff = largeFiles.map(file => [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${file}`,
        '@@ -0,0 +1,501 @@',
        ...Array.from({ length: 501 }, (_, index) => `+export const value${index} = ${index};`)
      ].join('\n')).join('\n');

      const result = await prAssistant['checkDeadCodeRemoval'](largeFiles, largeFilesDiff);

      expect(result.status).toBe('⚠️');
      expect(result.message).toBe('Minor code quality concerns found: 2 issues');
      expect(result.details).toEqual([
        'Consider breaking down src/first-large.ts into smaller, focused modules',
        'Consider breaking down src/second-large.ts into smaller, focused modules'
      ]);
    });

    it('should detect TODO comments', async () => {
      const result = await prAssistant['checkDeadCodeRemoval'](mockPRFiles, mockBadDiff);
      
      expect(result.details.some(d => d.includes('TODO') || d.includes('resolving'))).toBe(true);
    });
  });

  describe('OpenAI SDK Compatibility Check', () => {
    it('should pass for current SDK version', async () => {
      const result = await prAssistant['checkOpenAICompatibility'](mockPRFiles, mockPRDiff);
      
      expect(result.status).toBe('✅');
      expect(result.message).toContain('OpenAI SDK compatibility verified');
    });

    it('should detect legacy patterns', async () => {
      const legacyDiff = '+openai.Completion.create({ engine: "davinci" })';
      
      const result = await prAssistant['checkOpenAICompatibility'](mockPRFiles, legacyDiff);
      
      expect(result.status).toBe('❌');
      expect(result.details.some(d => d.includes('latest OpenAI SDK'))).toBe(true);
    });
  });

  describe('Railway Deployment Readiness', () => {
    it('should pass for proper environment usage', async () => {
      const envDiff = '+const port = process.env.PORT || 8080;';
      
      const result = await prAssistant['checkRailwayReadiness'](mockPRFiles, envDiff);
      
      expect(result.status).toBe('✅');
    });

    it('should detect hardcoded values', async () => {
      const result = await prAssistant['checkRailwayReadiness'](mockPRFiles, mockBadDiff);
      
      expect(result.status).toMatch(/❌|⚠️/);
      expect(result.details.some(d => d.includes('hardcoded') || d.includes('environment'))).toBe(true);
    });

    it('ignores structured logger event names', async () => {
      const loggerDiff = [
        '+logger.info("gaming.discovery.start", { query });',
        '+logger.info("gaming.discovery.end", { resultCount });',
        '+logger.warn("gaming.discovery.disabled", { reason });',
        '+const eventName = "gaming.discovery.start";',
        '+const ghostwriter = "api.games.example";'
      ].join('\n');

      const result = await prAssistant['checkRailwayReadiness'](['src/services/gaming.ts'], loggerDiff);

      expect(result.status).toBe('✅');
      expect(result.details).toEqual(['Proper environment variable usage and Railway compatibility']);
    });

    it('detects hardcoded bare domains assigned to host, URL, and domain settings', async () => {
      const domainDiffs = [
        "+const discoveryHostname = 'api.games.example';",
        "+const apiUrl = 'api.games.example';",
        "+const API_HOST = 'edge-1.games.example';",
        "+const settings = { domain: 'assets.games.example' };"
      ];

      for (const domainDiff of domainDiffs) {
        const result = await prAssistant['checkRailwayReadiness'](['src/services/gaming.ts'], domainDiff);

        expect(result.status).toBe('⚠️');
        expect(result.details).toContain('Move hardcoded values to environment variables');
      }
    });

    it('ignores lockfile and test-only values that look hardcoded', async () => {
      const nonRuntimeDiff = [
        'diff --git a/package-lock.json b/package-lock.json',
        'index 1111111..2222222 100644',
        '--- a/package-lock.json',
        '+++ b/package-lock.json',
        '@@ -1,3 +1,3 @@',
        '+      "version": "6.25.0",',
        '+      "resolved": "https://registry.npmjs.org/openai/-/openai-6.25.0.tgz",',
        'diff --git a/tests/worker-autonomy-service.test.ts b/tests/worker-autonomy-service.test.ts',
        'index 1111111..2222222 100644',
        '--- a/tests/worker-autonomy-service.test.ts',
        '+++ b/tests/worker-autonomy-service.test.ts',
        '@@ -1,3 +1,3 @@',
        '+        JOB_WORKER_WATCHDOG_MS: "15000",',
        '+        expect(settings.watchdogIntervalMs).toBe(15_000);'
      ].join('\n');

      const result = await prAssistant['checkRailwayReadiness'](
        ['package-lock.json', 'tests/worker-autonomy-service.test.ts'],
        nonRuntimeDiff
      );

      expect(result.status).toBe('✅');
    });

    it('does not require env docs for moved existing environment reads', async () => {
      const movedEnvDiff = [
        'diff --git a/src/services/worker.ts b/src/services/worker.ts',
        'index 1111111..2222222 100644',
        '--- a/src/services/worker.ts',
        '+++ b/src/services/worker.ts',
        '@@ -1,4 +1,4 @@',
        '-const webhook = process.env.WORKER_FAILURE_WEBHOOK_URL?.trim() || null;',
        '+const webhookUrl = process.env.WORKER_FAILURE_WEBHOOK_URL?.trim() || null;'
      ].join('\n');

      const result = await prAssistant['checkRailwayReadiness'](['src/services/worker.ts'], movedEnvDiff);

      expect(result.status).toBe('✅');
    });

    it('still requires env docs for newly added production environment reads', async () => {
      const newEnvDiff = [
        'diff --git a/src/services/worker.ts b/src/services/worker.ts',
        'index 1111111..2222222 100644',
        '--- a/src/services/worker.ts',
        '+++ b/src/services/worker.ts',
        '@@ -1,3 +1,4 @@',
        '+const workerFlag = process.env.ARCANOS_UNDOCUMENTED_WORKER_FLAG;'
      ].join('\n');

      const result = await prAssistant['checkRailwayReadiness'](['src/services/worker.ts'], newEnvDiff);

      expect(result.status).toMatch(/❌|⚠️/);
      expect(result.details).toContain('Update .env.example with new environment variables');
    });
  });

  describe('Full PR Analysis', () => {
    it('should analyze a clean PR successfully', async () => {
      // Mock successful test execution by creating a simple test command
      const originalCwd = process.cwd();
      
      // Create mock test scripts
      await fs.writeFile(
        path.join(tempDir, 'simple-test.js'), 
        'console.log("✓ All tests passed"); process.exit(0);'
      );
      
      const result = await prAssistant.analyzePR(mockPRDiff, mockPRFiles);
      
      expect(result).toBeDefined();
      expect(result.status).toMatch(/✅|⚠️|❌/);
      expect(result.checks).toHaveProperty('deadCodeRemoval');
      expect(result.checks).toHaveProperty('simplification');
      expect(result.checks).toHaveProperty('openaiCompatibility');
      expect(result.checks).toHaveProperty('railwayReadiness');
      expect(result.checks).toHaveProperty('automatedValidation');
      expect(result.checks).toHaveProperty('finalDoubleCheck');
      
      process.chdir(originalCwd);
    });

    it('should not let warnings hide failed checks', async () => {
      runCommandMock.mockRejectedValueOnce(new Error('Command timed out after 900000ms: npm test'));

      const result = await prAssistant.analyzePR(mockPRDiff, mockPRFiles);

      expect(result.status).toBe('❌');
      expect(result.summary).toContain('REJECTED');
      expect(result.checks.deadCodeRemoval.status).toBe('✅');
      expect(result.checks.automatedValidation.status).toBe('❌');
    });

    it('should not treat passing stderr output as an automated validation failure', async () => {
      runCommandMock.mockResolvedValue({
        stdout: '',
        stderr: 'PASS tests/example.test.ts\n  ● Console\n\n    console.log test output'
      });

      const result = await prAssistant.analyzePR(mockPRDiff, mockPRFiles);

      expect(result.checks.automatedValidation.status).toBe('✅');
    });

    it('should treat simplification-only findings as advisory instead of rejected', async () => {
      await fs.mkdir(path.join(tempDir, 'src', 'services'), { recursive: true });
      await fs.writeFile(path.join(tempDir, 'src', 'server.ts'), 'export {};\n');
      await fs.writeFile(path.join(tempDir, 'src', 'services', 'openai.ts'), 'export {};\n');

      const longText = 'x'.repeat(120);
      const advisoryComplexityDiff = `
diff --git a/src/advisory.ts b/src/advisory.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/advisory.ts
@@ -0,0 +1,14 @@
+export function advisoryExample(enabled: boolean, nested: boolean) {
+  if (enabled) { if (nested) { return 1000; } }
+  if (enabled) { if (!nested) { return 1001; } }
+  if (!enabled) { if (nested) { return 1002; } }
+  const largeText = '${longText}';
+  const firstLimit = 1000;
+  const secondLimit = 2000;
+  const thirdLimit = 3000;
+  return firstLimit + secondLimit + thirdLimit;
+}
`;

      const result = await prAssistant.analyzePR(advisoryComplexityDiff, ['src/advisory.ts']);

      expect(result.checks.simplification.status).toBe('⚠️');
      expect(result.status).toBe('⚠️');
      expect(result.summary).toContain('CONDITIONAL');
    });

    it('should format results as markdown', async () => {
      const mockResult = {
        status: '✅' as const,
        summary: 'All checks passed',
        checks: {
          deadCodeRemoval: { status: '✅' as const, message: 'Clean', details: [] },
          simplification: { status: '✅' as const, message: 'Good', details: [] },
          openaiCompatibility: { status: '✅' as const, message: 'Compatible', details: [] },
          railwayReadiness: { status: '✅' as const, message: 'Ready', details: [] },
          automatedValidation: { status: '✅' as const, message: 'Passed', details: [] },
          finalDoubleCheck: { status: '✅' as const, message: 'Complete', details: [] }
        },
        reasoning: 'All good',
        recommendations: []
      };

      const markdown = prAssistant.formatAsMarkdown(mockResult);
      
      expect(markdown).toContain('# 🤖 ARCANOS PR Analysis Report');
      expect(markdown).toContain('## ✅ Summary');
      expect(markdown).toContain('Dead/Bloated Code Removal');
      expect(markdown).toContain('OpenAI SDK Compatibility');
      expect(markdown).toContain('Railway Deployment Readiness');
      expect(markdown).toContain('PRODUCTION READY');
    });
  });

  describe('Validation Edge Cases', () => {
    it('should handle empty diff gracefully', async () => {
      const result = await prAssistant.analyzePR('', []);
      
      expect(result).toBeDefined();
      expect(result.status).toMatch(/✅|⚠️|❌/);
    });

    it('should handle missing files gracefully', async () => {
      const result = await prAssistant['checkDeadCodeRemoval'](['nonexistent.ts'], mockPRDiff);
      
      expect(result).toBeDefined();
      expect(result.status).toMatch(/✅|⚠️|❌/);
    });
  });
});

describe('PR Analysis API Integration', () => {
  it('should have correct interface types', () => {
    // This is a compile-time test to ensure types are correct
    const mockResult = {
      status: '✅' as const,
      summary: 'test',
      checks: {
        deadCodeRemoval: { status: '✅' as const, message: 'test', details: [] },
        simplification: { status: '✅' as const, message: 'test', details: [] },
        openaiCompatibility: { status: '✅' as const, message: 'test', details: [] },
        railwayReadiness: { status: '✅' as const, message: 'test', details: [] },
        automatedValidation: { status: '✅' as const, message: 'test', details: [] },
        finalDoubleCheck: { status: '✅' as const, message: 'test', details: [] }
      },
      reasoning: 'test',
      recommendations: ['test']
    };

    expect(mockResult.status).toMatch(/✅|⚠️|❌/);
    expect(Array.isArray(mockResult.recommendations)).toBe(true);
  });
});
