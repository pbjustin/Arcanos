// Server-side implementation of Backstage Booker functions
// This demonstrates the core functionality in CommonJS format

const axios = require('axios');

// ✅ FETCH FUNCTION
// Fetches live background worker status from backend API
async function getWorkerStatus() {
  try {
    const response = await axios.get('http://localhost:8080/api/booker/workers/status');
    if (response.status !== 200) throw new Error('Failed to fetch worker status');
    return response.data; // Array of worker objects with { id, task, status, cpu, ram, uptime }
  } catch (err) {
    console.error('Worker status error:', err.message);
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

console.log('🧠 BACKSTAGE BOOKER — SERVER-SIDE IMPLEMENTATION TEST\n');

async function demonstrateServerSideUsage() {
  try {
    console.log('📊 Fetching worker status...');
    const workers = await getWorkerStatus();
    console.log(`✅ Retrieved ${workers.length} workers`);
    
    workers.forEach(worker => {
      const cpuValue = parseFloat(worker.cpu);
      const status = cpuValue > 70 ? '⚠️ HIGH' : '✅ Normal';
      console.log(`  - ${worker.id}: ${worker.task} (${worker.status}) - CPU: ${worker.cpu} ${status}`);
    });

    console.log('\n🔍 Running load monitoring check...');
    
    // Capture console.warn output to demonstrate monitoring
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => {
      warnings.push(args.join(' '));
      originalWarn(...args);
    };
    
    await monitorLoad();
    
    // Restore console.warn
    console.warn = originalWarn;
    
    console.log(`\n📈 Monitoring results: ${warnings.length} alerts triggered`);
    if (warnings.length === 0) {
      console.log('  ✅ No high-load workers detected');
    }
    
    console.log('\n✅ Server-side demonstration completed successfully!');
    console.log('\n📦 This demonstrates the core functionality for:');
    console.log('  - System monitoring and alerts');
    console.log('  - Autoscaling decision support');
    console.log('  - Workload coordination');
    console.log('  - Background health checks');
    console.log('  - Load balancer routing decisions');
    
  } catch (error) {
    console.error('❌ Server-side usage failed:', error.message);
  }
}

demonstrateServerSideUsage();

module.exports = { getWorkerStatus, monitorLoad };