const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Path for memory persistence
const MEMORY_PATH = path.join(__dirname, 'memory', 'state.json');

// Load memory from disk
function loadMemory() {
  if (fs.existsSync(MEMORY_PATH)) {
    return JSON.parse(fs.readFileSync(MEMORY_PATH, 'utf8'));
  }
  return { config: {}, registry: [], auth: {}, saveData: {}, session: null, cache: {} };
}

// Save memory to disk
function saveMemory(state) {
  fs.writeFileSync(MEMORY_PATH, JSON.stringify(state, null, 2));
}

// Reset memory (non-destructive, preserves config/registry/auth/saveData)
function resetMemory() {
  const state = loadMemory();
  const preserved = {
    config: state.config,
    registry: state.registry,
    auth: state.auth,
    saveData: state.saveData
  };
  saveMemory(preserved);
  console.log('🧹 Non-destructive reset complete.');
}

// Invoke ARCANOS (main model)
async function invokeArcanos(prompt) {
  const state = loadMemory();

  const response = await client.chat.completions.create({
    model: "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote",
    messages: [
      { role: "system", content: "You are ARCANOS, a modular logic shell." },
      { role: "user", content: prompt }
    ]
  });

  // Optional: update session memory
  state.session = { lastPrompt: prompt, lastResponse: response.choices[0].message.content };
  saveMemory(state);

  return response.choices[0].message.content;
}

module.exports = {
  loadMemory,
  saveMemory,
  resetMemory,
  invokeArcanos
};
