// Patch: Force Worker Activation & Module Init
import { initializeWorker } from './src/services/init.js';
const workers = ['goalTracker', 'maintenanceScheduler', 'emailDispatcher', 'auditProcessor'];
workers.forEach(async (worker) => {
    try {
        await initializeWorker(worker);
        console.log(`✅ ${worker} started successfully`);
    }
    catch (err) {
        console.error(`❌ Failed to start ${worker}:`, err);
    }
});
