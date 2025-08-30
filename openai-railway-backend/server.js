const express = require('express');
const fs = require('fs');
const path = require('path');
const { dispatch, registry } = require('./architect');

const app = express();
app.use(express.json());

const MODULES_DIR = path.join(__dirname, 'modules');
const REGISTRY_PATH = path.join(__dirname, 'moduleRegistry.json');

// --- Auto-loader & Registry Updater ---
function loadModules() {
  const files = fs.readdirSync(MODULES_DIR).filter(f => f.endsWith('.js'));
  const registry = {};

  files.forEach(file => {
    try {
      const mod = require(path.join(MODULES_DIR, file));
      const route = mod.route || `/${path.basename(file, '.js')}`;
      registry[route] = {
        file,
        description: mod.description || 'No description',
        methods: Object.keys(mod.handlers || { POST: mod.handler })
      };
    } catch (err) {
      console.warn(`Failed to load module ${file}: ${err.message}`);
    }
  });

  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  return registry;
}

// --- Initial Load ---
let moduleRegistry = loadModules();

// --- Watcher (Optional: Hot-reload on change) ---
if (process.env.NODE_ENV !== 'test') {
  fs.watch(MODULES_DIR, () => {
    moduleRegistry = loadModules();
  });
}

// --- Dynamic Route Binder ---
Object.entries(moduleRegistry).forEach(([route, modMeta]) => {
  const mod = require(path.join(MODULES_DIR, modMeta.file));
  const handler = mod.handler || mod.handlers?.POST;

  app.post(route, async (req, res) => {
    try {
      const result = await handler(req.body, req, res);
      res.json({ status: 'success', data: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
});

// --- Dispatch Endpoint ---
app.post('/ask', async (req, res) => {
  try {
    const { module, payload } = req.body;
    const result = await dispatch(module, payload);
    res.json({ status: 'success', module, data: result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// --- Health & Registry Routes ---
app.get('/registry', (req, res) => res.json({ routes: moduleRegistry, modules: registry() }));
app.get('/health', (req, res) => res.send('OK'));

// --- Railway Port Binding ---
const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on ${PORT}`));
}

module.exports = app;
