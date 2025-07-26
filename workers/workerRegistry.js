const fs = require('fs');
const path = require('path');
const registry = new Map();

function loadModules() {
  const modulesDir = path.resolve(__dirname, 'modules');
  if (!fs.existsSync(modulesDir)) return;
  const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
  files.forEach(file => {
    try {
      const mod = require(path.join(modulesDir, file));
      if (mod && mod.name && typeof mod.handler === 'function') {
        registry.set(mod.name, mod.handler);
      } else {
        console.warn(`[WorkerRegistry] Invalid module ${file}`);
      }
    } catch (err) {
      console.error(`[WorkerRegistry] Failed to load module ${file}:`, err.message);
    }
  });
}

function getWorker(name) {
  return registry.get(name);
}

function getWorkers() {
  return Array.from(registry.keys());
}

loadModules();

module.exports = { workerRegistry: registry, loadModules, getWorker, getWorkers };
