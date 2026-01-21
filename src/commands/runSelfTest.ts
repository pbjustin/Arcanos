import { runSelfTestPipeline } from '../services/selfTestPipeline.js';

async function main() {
  try {
    const summary = await runSelfTestPipeline({
      baseUrl: process.env.SELF_TEST_BASE_URL,
      triggeredBy: 'cli'
    });

    console.log('[SELF-TEST] Completed');
    console.log(JSON.stringify(summary, null, 2));

    if (summary.failCount > 0) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('[SELF-TEST] Failed to execute pipeline', error);
    process.exit(1);
  }
}

void main();
