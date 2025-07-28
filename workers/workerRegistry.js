const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const registry = new Map();
const metadata = {
  emailDispatcher: { type: 'onDemand', endpoint: '/email/send' },
  maintenanceScheduler: { type: 'recurring', interval: 'weekly' },
  auditProcessor: { type: 'logic', mode: 'CLEAR' },
  scheduled_emails_worker: { type: 'cron', endpoint: '/email/schedule' },
};

// Persistent storage for registered workers
const REGISTRY_FILE = path.resolve(__dirname, '../storage/registered-workers.json');
let registeredWorkers = [];
let scheduleRegistry = [];

// AI controller event emitter for integration
const aiController = new EventEmitter();

// Initialize persistent storage
function initializePersistence() {
  // Ensure storage directory exists
  const storageDir = path.resolve(__dirname, '../storage');
  if (!fs.existsSync(storageDir)) {
    fs.mkdirSync(storageDir, { recursive: true });
  }
  
  // Load existing registered workers
  if (fs.existsSync(REGISTRY_FILE)) {
    try {
      const data = fs.readFileSync(REGISTRY_FILE, 'utf8');
      registeredWorkers = JSON.parse(data);
      console.log(`[WorkerRegistry] Loaded ${registeredWorkers.length} registered workers`);
    } catch (error) {
      console.error('[WorkerRegistry] Failed to load registered workers:', error.message);
      registeredWorkers = [];
    }
  }
}

// Save registered workers to persistent storage
function saveRegisteredWorkers() {
  try {
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registeredWorkers, null, 2));
    console.log(`[WorkerRegistry] Saved ${registeredWorkers.length} registered workers`);
  } catch (error) {
    console.error('[WorkerRegistry] Failed to save registered workers:', error.message);
  }
}

function validateWorker(workerName) {
  return registeredWorkers.includes(workerName);
}

function registerWorker(workerName) {
  if (!registeredWorkers.includes(workerName)) {
    registeredWorkers.push(workerName);
    saveRegisteredWorkers();
    console.log(`✅ Registered: ${workerName}`);
    // Emit event for AI control integration
    aiController.emit('workerRegistered', workerName);
  }
}

function scheduleJob(job) {
  if (!validateWorker(job.worker)) {
    console.error(`❌ Invalid worker: ${job.worker} — Job dropped.`);
    return;
  }
  scheduleRegistry.push(job);
  console.log(`✅ Job scheduled for: ${job.worker} at ${job.schedule}`);
}

// Eliminate fallback defaultWorker behavior
let fallbackScheduler = null;

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
        // Auto-register worker when module is loaded
        registerWorker(name);
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

// Initialize persistence and load modules
initializePersistence();
loadModules();

// Register built-in workers (excluding defaultWorker to eliminate fallback behavior)
const builtInWorkers = ['memorySync', 'goalWatcher', 'clearTemp', 'codeImprovement', 'auditProcessor', 'maintenanceScheduler', 'emailDispatcher', 'scheduled_emails_worker'];
builtInWorkers.forEach(registerWorker);

// Hook to AI-control registration pipeline
aiController.on('registerWorker', (workerName) => registerWorker(workerName));

console.log('🔁 Worker validation pipeline updated. AI control sync complete.');

module.exports = { 
  workerRegistry: registry, 
  loadModules, 
  getWorker, 
  getWorkers, 
  getMetadata,
  validateWorker,
  registerWorker,
  scheduleJob,
  registeredWorkers: () => [...registeredWorkers], // Return copy to prevent mutation
  scheduleRegistry: () => [...scheduleRegistry], // Return copy to prevent mutation
  fallbackScheduler,
  aiController
};
