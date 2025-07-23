const pool = require('./database-connection');
const fs = require('fs');
const path = require('path');

const AUDIT_FILE = path.join(__dirname, '../memory/state/audit.log');

function logAudit(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(AUDIT_FILE, line);
  } catch (err) {
    console.error('Failed to write audit log:', err.message);
  }
}

async function recordWrite(key, value, tag = null) {
  const { rows } = await pool.query('SELECT COALESCE(MAX(version),0) AS v FROM memory_state WHERE key = $1', [key]);
  const nextVersion = Number(rows[0].v) + 1;
  await pool.query(
    'INSERT INTO memory_state (key, value, version, tag) VALUES ($1,$2,$3,$4)',
    [key, JSON.stringify(value), nextVersion, tag]
  );
  logAudit(`write key=${key} version=${nextVersion} tag=${tag || ''}`);
  return nextVersion;
}

async function getVersions(key) {
  const result = await pool.query('SELECT version, timestamp, tag FROM memory_state WHERE key = $1 ORDER BY version', [key]);
  return result.rows;
}

async function getValue(key, version) {
  const res = await pool.query('SELECT value FROM memory_state WHERE key=$1 AND version=$2', [key, version]);
  return res.rows[0] ? res.rows[0].value : null;
}

function computeDiff(a, b) {
  const diff = {};
  const aObj = a || {};
  const bObj = b || {};
  const keys = new Set([...Object.keys(aObj), ...Object.keys(bObj)]);
  keys.forEach(k => {
    const av = JSON.stringify(aObj[k]);
    const bv = JSON.stringify(bObj[k]);
    if (av !== bv) {
      diff[k] = { from: aObj[k], to: bObj[k] };
    }
  });
  return diff;
}

async function diffVersions(key, fromV, toV) {
  const fromVal = await getValue(key, fromV);
  const toVal = await getValue(key, toV);
  return {
    key,
    from: fromV,
    to: toV,
    diff: computeDiff(fromVal, toVal)
  };
}

async function rollback(key, version) {
  const value = await getValue(key, version);
  if (value === null) {
    throw new Error('Version not found');
  }
  // update memory table
  await pool.query(
    'INSERT INTO memory(key, value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
    [key, JSON.stringify(value)]
  );
  // log new snapshot representing rollback
  const { rows } = await pool.query('SELECT COALESCE(MAX(version),0) AS v FROM memory_state WHERE key=$1', [key]);
  const newVersion = Number(rows[0].v) + 1;
  await pool.query(
    'INSERT INTO memory_state (key, value, version, tag) VALUES ($1,$2,$3,$4)',
    [key, JSON.stringify(value), newVersion, `rollback-to-${version}`]
  );
  logAudit(`rollback key=${key} to version=${version}`);
  return { key, value, version: newVersion };
}

module.exports = {
  recordWrite,
  getVersions,
  diffVersions,
  rollback
};
