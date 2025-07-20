// 🧠 BACKSTAGE BOOKER — COPILOT INTEGRATION: BACKGROUND WORKER STATUS
// Purpose: Access background worker health without displaying in UI

// ✅ FETCH FUNCTION
// Fetches live background worker status from backend API
export async function getWorkerStatus() {
  try {
    const response = await fetch('/api/booker/workers/status');
    if (!response.ok) throw new Error('Failed to fetch worker status');
    const data = await response.json();
    return data; // Array of worker objects with { id, task, status, cpu, ram, uptime }
  } catch (err) {
    console.error('Worker status error:', err);
    return [];
  }
}

// ✅ LOGIC USAGE EXAMPLE
// Background monitoring, alerts, or load balancers
async function monitorLoad() {
  const workers = await getWorkerStatus();

  for (const worker of workers) {
    if (worker.status === 'running' && parseFloat(worker.cpu) > 70) {
      console.warn(`⚠️ High load: ${worker.id} using ${worker.cpu} CPU`);
      // Add: route failover, delay queue, or notify dev
    }
  }
}

// ✅ POLLING CYCLE (Optional)
let pollingInterval = null;

// Start monitoring with 60-second intervals
export function startMonitoring() {
  if (pollingInterval) {
    console.log('📊 Monitoring already running');
    return;
  }
  
  console.log('🚀 Starting worker monitoring (60s intervals)');
  pollingInterval = setInterval(() => {
    monitorLoad();
  }, 60000); // Every 60 seconds
  
  // Run initial check
  monitorLoad();
}

// Stop monitoring
export function stopMonitoring() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    console.log('⏹️ Worker monitoring stopped');
  }
}

// Export monitoring function for direct usage
export { monitorLoad };

// 🔒 No UI output — for backend logic only
// 📦 Used for system monitoring, autoscaling, and workload coordination

// Auto-start monitoring if running in a browser environment
if (typeof window !== 'undefined') {
  console.log('🎯 Backstage Booker module loaded - call startMonitoring() to begin');
}