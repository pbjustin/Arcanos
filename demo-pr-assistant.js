#!/usr/bin/env node

/**
 * ARCANOS PR Assistant Demo
 * Demonstrates the PR analysis functionality with sample data
 */

import { PRAssistant } from './dist/services/prAssistant.js';

console.log('🤖 ARCANOS PR Assistant Demo\n');

// Sample PR data
const samplePRs = [
  {
    name: 'Clean PR',
    diff: `diff --git a/src/utils/helper.ts b/src/utils/helper.ts
new file mode 100644
index 0000000..abc123
--- /dev/null
+++ b/src/utils/helper.ts
@@ -0,0 +1,8 @@
+export function calculateSum(a: number, b: number): number {
+  return a + b;
+}
+
+export function formatOutput(data: any): string {
+  return JSON.stringify(data, null, 2);
+}`,
    files: ['src/utils/helper.ts']
  },
  {
    name: 'Problematic PR',
    diff: `diff --git a/src/bad-code.ts b/src/bad-code.ts
new file mode 100644
index 0000000..def456
--- /dev/null
+++ b/src/bad-code.ts
@@ -0,0 +1,20 @@
+// TODO: Refactor this entire file
+console.log('Debug: Starting application');
+console.error('This is not an error, just logging');
+console.warn('Warning message');
+console.debug('Debug info');
+console.info('Info message');
+
+// Hardcoded values that should be environment variables
+const API_KEY = 'sk-1234567890abcdefghij';
+const SERVER_PORT = 3000;
+const API_URL = 'https://api.hardcoded-service.com';
+
+// Legacy OpenAI usage
+const result = await openai.Completion.create({
+  engine: 'davinci',
+  prompt: 'Hello world'
+});
+
+// Overly complex nested function
+function processData(data: any) {
+  if (data) {
+    if (data.items) {
+      for (let i = 0; i < data.items.length; i++) {
+        if (data.items[i].status === 'active') {
+          while (data.items[i].processing) {
+            // More nested logic here
+          }
+        }
+      }
+    }
+  }
+}`,
    files: ['src/bad-code.ts']
  }
];

async function runDemo() {
  const assistant = new PRAssistant();

  for (const pr of samplePRs) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`📋 Analyzing: ${pr.name}`);
    console.log(`${'='.repeat(50)}\n`);

    try {
      const result = await assistant.analyzePR(pr.diff, pr.files);
      
      console.log(`Status: ${result.status}`);
      console.log(`Summary: ${result.summary}\n`);
      
      console.log('📊 Check Results:');
      Object.entries(result.checks).forEach(([check, details]) => {
        console.log(`  ${details.status} ${check}: ${details.message}`);
      });
      
      if (result.recommendations.length > 0) {
        console.log('\n💡 Recommendations:');
        result.recommendations.slice(0, 3).forEach(rec => {
          console.log(`  • ${rec}`);
        });
        if (result.recommendations.length > 3) {
          console.log(`  ... and ${result.recommendations.length - 3} more`);
        }
      }

      console.log('\n📝 Markdown Report Preview:');
      const markdown = assistant.formatAsMarkdown(result);
      const lines = markdown.split('\n');
      console.log(lines.slice(0, 10).join('\n'));
      if (lines.length > 10) {
        console.log(`... (${lines.length - 10} more lines)`);
      }

    } catch (error) {
      console.error(`❌ Error analyzing ${pr.name}:`, error.message);
    }
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log('🎯 Demo Complete!');
  console.log(`${'='.repeat(50)}`);
  console.log('\n📚 For more information, see docs/PR_ASSISTANT_README.md');
  console.log('🌐 API endpoint: POST /api/pr-analysis/analyze');
  console.log('🔍 Health check: GET /api/pr-analysis/health');
}

// Run the demo
runDemo().catch(error => {
  console.error('💥 Demo failed:', error);
  process.exit(1);
});