// Server-side usage example of the Backstage Booker functionality
// This demonstrates how the code would be used in a backend context

// Simulate fetch for Node.js environment
const axios = require('axios');
global.fetch = async (url) => {
  const response = await axios.get(url);
  return {
    ok: response.status >= 200 && response.status < 300,
    json: async () => response.data
  };
};

// Import the functions (simulating ES module import)
const fs = require('fs');
const bookerCode = fs.readFileSync('./public/backstage-booker.js', 'utf8');

// Extract the functions using eval (for demonstration - in production use proper module loading)
const getWorkerStatus = eval(`
  ${bookerCode}
  getWorkerStatus;
`);

const monitorLoad = eval(`
  ${bookerCode}
  monitorLoad;
`);

console.log('🧠 BACKSTAGE BOOKER — SERVER-SIDE USAGE EXAMPLE\n');

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
    
    // Capture console.warn output
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
    warnings.forEach(warning => console.log(`  ${warning}`));
    
    console.log('\n✅ Server-side demonstration completed successfully!');
    console.log('\n📦 This demonstrates how the module can be used for:');
    console.log('  - System monitoring');
    console.log('  - Autoscaling decisions');
    console.log('  - Workload coordination');
    console.log('  - Background health checks');
    
  } catch (error) {
    console.error('❌ Server-side usage failed:', error.message);
  }
}

demonstrateServerSideUsage();