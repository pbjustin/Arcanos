const fs = require('fs');
const path = require('path');
const registry = new Map();
const metadata = {
  emailDispatcher: { type: 'onDemand', endpoint: '/email/send' },
  maintenanceScheduler: { type: 'recurring', interval: 'weekly' },
  auditProcessor: { type: 'logic', mode: 'CLEAR' },
  scheduled_emails_worker: { type: 'cron', endpoint: '/email/schedule' },
};

function loadModules() {
  const modulesDir = path.resolve(__dirname, 'modules');
  if (!fs.existsSync(modulesDir)) return;
  const files = fs.readdirSync(modulesDir).filter(f => f.endsWith('.js'));
  files.forEach(file => {
    try {
      const mod = require(path.join(modulesDir, file));
      const name = mod && typeof mod.name === 'string' ? mod.name.trim() : '';
      if (name && typeof mod.handler === 'function') {
        registry.set(name, mod.handler);
        if (!metadata[name]) metadata[name] = { type: 'custom' };
      } else {
        console.warn(`[WorkerRegistry] Invalid module ${file} - missing name`);
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

function getMetadata(name) {
  return metadata[name];
}

loadModules();

module.exports = { workerRegistry: registry, loadModules, getWorker, getWorkers, getMetadata };
