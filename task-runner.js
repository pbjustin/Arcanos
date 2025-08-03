#!/usr/bin/env node
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import axios from 'axios';
import { OpenAI } from 'openai';
import Ajv from 'ajv';

const ajv = new Ajv({ strict: true });

function loadSchema(filename) {
  const file = path.join(process.cwd(), 'schemas', filename);
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

const shellSchema = loadSchema('gpt_shell_manager.json');
const agentSchema = loadSchema('scoped_task_agent.json');
const validateShell = ajv.compile(shellSchema);
const validateAgent = ajv.compile(agentSchema);

if (!process.env.OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY environment variable is missing');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const OVERSEER_ID = process.env.OVERSEER_ID;
const RUNTIME_COMPANION_ID = process.env.RUNTIME_COMPANION_ID;
const LOG_WEBHOOK = process.env.LOG_WEBHOOK_URL;

async function logSystem(data) {
  if (LOG_WEBHOOK) {
    try {
      await axios.post(LOG_WEBHOOK, data);
    } catch (err) {
      console.error('Failed to send log webhook:', err.message);
    }
  } else {
    console.log('[LOG]', JSON.stringify(data, null, 2));
  }
}

async function triggerAssistant(id, command, payload, retries = 1) {
  const thread = await openai.beta.threads.create();
  await openai.beta.threads.messages.create(thread.id, {
    role: 'user',
    content: JSON.stringify({ command, payload }),
  });
  const run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: id,
  });
  let status = run.status;
  while (status !== 'completed' && status !== 'failed') {
    await new Promise((r) => setTimeout(r, 1000));
    const rInfo = await openai.beta.threads.runs.retrieve(run.id, {
      thread_id: thread.id,
    });
    status = rInfo.status;
  }
  if (status === 'failed') {
    if (retries > 0) {
      await logSystem({ level: 'warn', message: 'Retrying assistant after failure' });
      return triggerAssistant(id, command, payload, retries - 1);
    }
    throw new Error('Assistant run failed');
  }
  const messages = await openai.beta.threads.messages.list(thread.id);
  const last = messages.data[messages.data.length - 1];
  const result = last?.content?.[0]?.text?.value || '';
  return result;
}

export async function execute(command, payload) {
  const assistant = command === 'runtime' ? RUNTIME_COMPANION_ID : OVERSEER_ID;
  if (!assistant) throw new Error('Assistant ID not configured');
  const response = await triggerAssistant(assistant, command, payload).catch(async (err) => {
    await logSystem({ level: 'error', error: err.message });
    if (assistant !== OVERSEER_ID && OVERSEER_ID) {
      return triggerAssistant(OVERSEER_ID, command, payload);
    }
    throw err;
  });
  await logSystem({ level: 'info', response });
  return response;
}

async function main() {
  const [command = 'runtime', payloadArg] = process.argv.slice(2);
  const payload = payloadArg ? JSON.parse(payloadArg) : {};
  if (!validateShell({ command, ...payload }) || !validateAgent(payload)) {
    console.error('Input failed validation');
    process.exit(1);
  }
  try {
    await execute(command, payload);
  } catch (err) {
    await logSystem({ level: 'error', error: err.message });
    process.exit(1);
  }
}

// ESM module entry point detection
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
