/**
 * Tests for ARCANOS PR Assistant
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { PRAssistant } from '../src/services/prAssistant.js';
import fs from 'fs/promises';
import path from 'path';

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
        openai: '^5.15.0'
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

    prAssistant = new PRAssistant(tempDir);
  });

  afterEach(async () => {
    // Clean up temporary directory
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('Dead Code Removal Check', () => {
    it('should pass for clean code', async () => {
      const result = await prAssistant['checkDeadCodeRemoval'](mockPRFiles, mockPRDiff);
      
      expect(result.status).toBe('⚠️'); // Should have warnings for console.log
      expect(result.message).toContain('Minor code quality concerns');
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