#!/usr/bin/env node
require('ts-node/register');
const { runEmailDiagnostic } = require('../src/services/email-diagnostic');

async function main() {
  const [to, subject = 'Diagnostic Email', ...rest] = process.argv.slice(2);
  const html = rest.join(' ') || '<p>Test</p>';
  if (!to) {
    console.error('Usage: email-diagnostic <to> [subject] [html]');
    process.exit(1);
  }
  try {
    const result = await runEmailDiagnostic(to, subject, html);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('email-diagnostic error:', err.message);
    process.exit(1);
  }
}

main();
