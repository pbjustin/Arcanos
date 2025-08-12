import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Path for persistent internal storage
const logFilePath = path.join(__dirname, 'internal_agent_logs.json');

// Utility function for timestamped log entries
function createLogEntry(agent, severity, message) {
  return {
    timestamp: new Date().toISOString(),
    agent,
    severity,
    message,
  };
}

// Append to internal storage
function appendToInternalLogs(entry) {
  let logs = [];
  if (fs.existsSync(logFilePath)) {
    logs = JSON.parse(fs.readFileSync(logFilePath, 'utf8'));
  }
  logs.push(entry);
  fs.writeFileSync(logFilePath, JSON.stringify(logs, null, 2), 'utf8');
}

// Mirror to Railway standard logs
function logToConsole(entry) {
  console.log(`[${entry.timestamp}] [${entry.agent}] [${entry.severity}] ${entry.message}`);
}

// Main logging function
export function logAgentEvent(agent, severity, message) {
  const entry = createLogEntry(agent, severity, message);
  appendToInternalLogs(entry);
  logToConsole(entry);
}

// Example: Hook into ARCANOS events
export function attachAgentLoggers(arc) {
  arc.on('overseer:event', (msg) => logAgentEvent('Overseer', 'INFO', msg));
  arc.on('overseer:warn', (msg) => logAgentEvent('Overseer', 'WARN', msg));
  arc.on('overseer:error', (msg) => logAgentEvent('Overseer', 'ERROR', msg));

  arc.on('maintenance:event', (msg) => logAgentEvent('Maintenance', 'INFO', msg));
  arc.on('maintenance:warn', (msg) => logAgentEvent('Maintenance', 'WARN', msg));
  arc.on('maintenance:error', (msg) => logAgentEvent('Maintenance', 'ERROR', msg));
}

