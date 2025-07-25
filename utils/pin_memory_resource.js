#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yargs = require('yargs');

const argv = yargs
  .option('label', { alias: 'l', type: 'string', demandOption: true, describe: 'Context label / container id' })
  .option('type', { alias: 't', type: 'string', choices: ['task', 'reference', 'logic'], demandOption: true, describe: 'Resource type' })
  .option('file', { alias: 'f', type: 'string', describe: 'Path to file with content to upload' })
  .option('key', { alias: 'k', type: 'string', describe: 'Optional memory key' })
  .option('base', { alias: 'b', type: 'string', describe: 'Base API URL' })
  .help()
  .argv;

const BASE_URL = argv.base || process.env.ARCANOS_URL || process.env.SERVER_URL || 'http://localhost:8080';
const memoryKey = argv.key || `${argv.type}_${Date.now()}`;

async function readContent() {
  if (argv.file) {
    return fs.readFileSync(path.resolve(argv.file), 'utf8');
  }
  return new Promise((resolve, reject) => {
    if (process.stdin.isTTY) {
      return reject(new Error('No input provided. Use --file or pipe data via stdin.'));
    }
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function main() {
  try {
    const content = await readContent();
    const payload = {
      memory_key: memoryKey,
      memory_value: {
        pinned: true,
        type: argv.type,
        content
      }
    };

    const res = await axios.post(`${BASE_URL}/api/memory/save`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Container-Id': argv.label
      }
    });

    console.log('✅ Pinned memory saved:', res.data);
  } catch (err) {
    const message = err.response?.data || err.message;
    console.error('❌ Failed to save pinned memory:', message);
    process.exit(1);
  }
}

main();
