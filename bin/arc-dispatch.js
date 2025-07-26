#!/usr/bin/env node
require('ts-node/register');
const { aiDispatcher } = require('../src/services/ai-dispatcher');

async function main() {
  const instruction = process.argv.slice(2).join(' ').trim();
  if (!instruction) {
    console.error('Usage: arc:dispatch <instruction string>');
    process.exit(1);
  }
  try {
    const response = await aiDispatcher.ask(instruction);
    console.log(response);
  } catch (err) {
    console.error('arc-dispatch error:', err.message);
    process.exit(1);
  }
}

main();
