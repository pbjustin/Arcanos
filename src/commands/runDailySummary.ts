import { generateDailySummary } from '../services/dailySummaryService.js';

async function main() {
  try {
    const summary = await generateDailySummary('cli');
    console.log('[DAILY-SUMMARY] Complete');
    console.log(JSON.stringify(summary, null, 2));
  } catch (error) {
    console.error('[DAILY-SUMMARY] Failed to generate summary', error);
    process.exit(1);
  }
}

void main();
