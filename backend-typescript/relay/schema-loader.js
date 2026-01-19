const fs = require('fs');
const path = require('path');

const schemaPath = path.resolve(process.cwd(), 'relay', 'schema.js');
let cachedSchema = null;
let cachedMtimeMs = 0;

function getRelaySchema() {
  const stat = fs.statSync(schemaPath);
  if (!cachedSchema || stat.mtimeMs !== cachedMtimeMs) {
    delete require.cache[require.resolve(schemaPath)];
    const loaded = require(schemaPath);
    cachedSchema = loaded.schema || loaded;
    cachedMtimeMs = stat.mtimeMs;
  }
  return cachedSchema;
}

function getRelaySchemaMeta() {
  const stat = fs.statSync(schemaPath);
  return {
    path: schemaPath,
    mtimeMs: cachedMtimeMs || stat.mtimeMs
  };
}

module.exports = {
  getRelaySchema,
  getRelaySchemaMeta,
  schemaPath
};
