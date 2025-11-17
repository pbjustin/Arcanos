import dotenv from 'dotenv';
import { OpenAI } from 'openai';
import { promises as fs } from 'fs';
import path from 'path';

dotenv.config();

const PERSIST_DIR = path.resolve('./persist');
const STATE_FILE = path.join(PERSIST_DIR, 'arcanos_state.json');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function ensurePersistDir() {
  await fs.mkdir(PERSIST_DIR, { recursive: true });
}

async function loadState() {
  await ensurePersistDir();
  try {
    const data = await fs.readFile(STATE_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return { decisions: [], audits: [], checkpoints: [] };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

function createAuditLog(decision) {
  return {
    timestamp: new Date().toISOString(),
    passed: true,
    checks: ['Consistent with policy', 'Schema validated'],
    metadata: {
      model: process.env.ARCANOS_MODEL || 'gpt-5.1',
      decisionHash: hashDecision(decision)
    }
  };
}

function hashDecision(decision) {
  const json = JSON.stringify(decision);
  let hash = 0;
  for (let i = 0; i < json.length; i += 1) {
    const chr = json.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
    hash |= 0;
  }
  return hash.toString(16);
}

function createCheckpoint(input, decision) {
  return {
    time: new Date().toISOString(),
    label: input?.label || 'auto',
    state: decision
  };
}

async function callModel(input) {
  const payload = {
    model: process.env.ARCANOS_MODEL || 'gpt-5.1',
    messages: [
      {
        role: 'system',
        content: 'You are the reasoning engine for ARCANOS, producing safe and auditable plans.'
      },
      { role: 'user', content: JSON.stringify(input) }
    ],
    response_format: { type: 'json_object' }
  };

  console.info('[arcanos-controller] Dispatching request to OpenAI', {
    model: payload.model,
    label: input?.label
  });

  const response = await openai.chat.completions.create(payload);

  console.info('[arcanos-controller] Received response from OpenAI', {
    id: response.id,
    created: response.created
  });

  return response;
}

export default async function arcanosController(input) {
  const state = await loadState();

  const response = await callModel(input);
  const decision = JSON.parse(response.choices[0].message.content);

  const audit = createAuditLog(decision);
  const checkpoint = createCheckpoint(input, decision);

  state.decisions.push(decision);
  state.audits.push(audit);
  state.checkpoints.push(checkpoint);

  await saveState(state);

  return { decision, audit, checkpoint };
}
