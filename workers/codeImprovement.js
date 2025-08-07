#!/usr/bin/env node
/**
 * Code Improvement Worker - OpenAI SDK Compliant
 * Analyzes and suggests code improvements using OpenAI API
 */

import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';

const MEMORY_LOG_PATH = process.env.NODE_ENV === 'production' ? '/var/arc/log/session.log' : './memory/session.log';
const WORKER_NAME = 'codeImprovement';

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

async function analyzeCodeImprovements() {
  try {
    logActivity('Starting code improvement analysis');
    
    // Use OpenAI SDK for code analysis
    const completion = await openai.chat.completions.create({
      model: process.env.AI_MODEL || 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a code improvement AI worker. Analyze code quality, performance, and suggest optimizations.'
        },
        {
          role: 'user',
          content: 'Analyze the ARCANOS codebase for potential improvements in performance, maintainability, and code quality.'
        }
      ],
      max_tokens: 300,
      temperature: 0.2
    });

    const result = completion.choices[0].message.content;
    logActivity(`Code analysis: ${result}`);
    
    logActivity('Code improvement analysis completed successfully');
    
    return { success: true, result, timestamp: new Date().toISOString() };
  } catch (error) {
    logActivity(`Error during code analysis: ${error.message}`);
    throw error;
  }
}

// Main worker execution
async function main() {
  logActivity(`Worker ${WORKER_NAME} started with model: ${process.env.AI_MODEL || 'gpt-3.5-turbo'}`);
  
  try {
    const result = await analyzeCodeImprovements();
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
export { analyzeCodeImprovements, logActivity };

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}