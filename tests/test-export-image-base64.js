#!/usr/bin/env node
import { exportImageAsBase64 } from '../dist/utils/exportImageAsBase64.js';

// Basic runtime test for exportImageAsBase64 utility
(async () => {
  const sample = Buffer.from('OpenAI');
  const result = exportImageAsBase64(sample, 8);
  console.log('Encoded output:\n', result);

  const lines = result.trim().split('\n');
  const marker = lines.pop();
  const base64Data = lines.join('');

  console.log('Marker line:', marker);
  console.log('Padding valid:', base64Data.length % 4 === 0);

  if (marker === '===EOI===' && base64Data.length % 4 === 0) {
    console.log('\n✅ exportImageAsBase64 passed basic checks');
  } else {
    console.error('\n❌ exportImageAsBase64 failed basic checks');
    process.exit(1);
  }
})();
