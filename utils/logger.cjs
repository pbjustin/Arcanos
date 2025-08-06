const fs = require('fs');
const path = require('path');
const logFile = path.join(__dirname, '../logs/arc.log');

function log(message) {
  const timestamp = new Date().toISOString();
  const output = `[${timestamp}] ${message}`;
  console.log(output);
  fs.appendFileSync(logFile, output + '\n');
}

module.exports = { log };