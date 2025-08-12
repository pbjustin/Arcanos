#!/usr/bin/env node
/**
 * ARCANOS Backend Monitor Worker
 *
 * Periodically collects system stats, checks backend health, and
 * sends summaries to OpenAI for analysis.
 */

import fs from 'fs';
import os from 'os';
import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Persistent monitoring loop interval (ms)
const LOOP_INTERVAL = 60000; // 1 min

async function logEvent(type, details) {
  const logLine = `[${new Date().toISOString()}] [${type}] ${details}\n`;
  fs.appendFileSync('./backend-monitor.log', logLine);
  console.log(logLine.trim());
}

async function getSystemStats() {
  return {
    cpuUsage: os.loadavg(),
    freeMem: os.freemem(),
    totalMem: os.totalmem(),
    uptime: os.uptime(),
    platform: os.platform(),
    timestamp: new Date().toISOString(),
  };
}

async function backendHealthCheck() {
  try {
    const healthRes = await fetch('http://localhost:8080/health');
    const status = await healthRes.json();
    await logEvent('HEALTH', `Backend status: ${JSON.stringify(status)}`);
  } catch (err) {
    await logEvent('ERROR', `Health check failed: ${err.message}`);
  }
}

async function sendSummaryToAI(stats) {
  try {
    const aiRes = await openai.chat.completions.create({
      model: 'gpt-5', // Replace with your active GPT model
      messages: [
        { role: 'system', content: 'You are a backend log analysis agent.' },
        { role: 'user', content: `Analyze these backend stats: ${JSON.stringify(stats)}` },
      ],
      max_completion_tokens: 300,
    });
    const analysis = aiRes.choices[0]?.message?.content || '[No analysis]';
    await logEvent('AI-ANALYSIS', analysis);
  } catch (err) {
    await logEvent('ERROR', `AI analysis failed: ${err.message}`);
  }
}

async function monitorLoop() {
  while (true) {
    const stats = await getSystemStats();
    await backendHealthCheck();
    await sendSummaryToAI(stats);
    await new Promise((res) => setTimeout(res, LOOP_INTERVAL));
  }
}

// Start the worker
monitorLoop();

