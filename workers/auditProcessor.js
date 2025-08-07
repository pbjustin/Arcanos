#!/usr/bin/env node
/**
 * Audit Processor Worker - OpenAI SDK Compliant
 * Performs system audits using OpenAI API
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const MEMORY_LOG_PATH = process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log';
const WORKER_NAME = 'auditProcessor';

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const logActivity = (message) => {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] [${WORKER_NAME}] ${message}\n`;
  
  try {
    const logDir = path.dirname(MEMORY_LOG_PATH);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    
    fs.appendFileSync(MEMORY_LOG_PATH, logEntry);
    console.log(logEntry.trim());
  } catch (error) {
    console.error(`Failed to write to log: ${error.message}`);
  }
};

async function processAudit() {
  try {
    logActivity('Starting system audit task');
    
    // Use OpenAI SDK for audit analysis
    const completion = await openai.chat.completions.create({
      model: process.env.AI_MODEL || 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a system audit AI worker. Analyze system performance, security, and compliance.'
        },
        {
          role: 'user',
          content: 'Perform a comprehensive audit of the ARCANOS system including security, performance, and operational status.'
        }
      ],
      max_tokens: 300,
      temperature: 0.1
    });

    const result = completion.choices[0].message.content;
    logActivity(`Audit analysis: ${result}`);
    
    logActivity('System audit completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logActivity(`Error during audit processing: ${error.message}`);
    throw error;
  }
}

// Main worker execution
async function main() {
  logActivity(`Worker ${WORKER_NAME} started with model: ${process.env.AI_MODEL || 'gpt-3.5-turbo'}`);
  
  try {
    const result = await processAudit();
    logActivity('Worker completed successfully');
    process.exit(0);
  } catch (error) {
    logActivity(`Worker failed: ${error.message}`);
    process.exit(1);
  }
}

// Handle process events
process.on('SIGINT', () => {
  logActivity('Worker interrupted');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logActivity('Worker terminated');
  process.exit(0);
});

// Export for testing
export { processAudit, logActivity };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}