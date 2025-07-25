// Test Enhanced Workers Functionality
console.log('🔧 Testing ARCANOS Enhanced Workers');
console.log('===================================');

// Mock the model control hooks for testing
const mockModelControlHooks = {
  manageMemory: async (action, params) => {
    console.log(`[MOCK] manageMemory called: ${action}`, params ? Object.keys(params) : 'no params');
    return { success: true, results: [{ result: [] }] };
  },
  performAudit: async (data, type) => {
    console.log(`[MOCK] performAudit called: ${type}`, Object.keys(data));
    return { success: true, response: 'audit completed' };
  },
  performMaintenance: async (action, params) => {
    console.log(`[MOCK] performMaintenance called: ${action}`, Object.keys(params));
    return { success: true };
  }
};

// Mock require to use our mock hooks
const originalRequire = require;
require = function(modulePath) {
  if (modulePath === '../src/services/model-control-hooks') {
    return { modelControlHooks: mockModelControlHooks };
  }
  if (modulePath === '../src/services/sleep-config') {
    return originalRequire('./dist/services/sleep-config');
  }
  return originalRequire.apply(this, arguments);
};

async function testWorkers() {
  try {
    // Test memorySync worker
    console.log('\n📸 Testing memorySync worker...');
    const memorySync = originalRequire('./workers/memorySync');
    await memorySync();
    console.log('✅ memorySync worker test completed');

    // Test goalWatcher worker
    console.log('\n🎯 Testing goalWatcher worker...');
    const goalWatcher = originalRequire('./workers/goalWatcher');
    await goalWatcher();
    console.log('✅ goalWatcher worker test completed');

    // Test clearTemp worker
    console.log('\n🧹 Testing clearTemp worker...');
    const clearTemp = originalRequire('./workers/clearTemp');
    await clearTemp();
    console.log('✅ clearTemp worker test completed');

    // Test codeImprovement worker
    console.log('\n💡 Testing codeImprovement worker...');
    const codeImprovement = originalRequire('./workers/codeImprovement');
    await codeImprovement();
    console.log('✅ codeImprovement worker test completed');

    console.log('\n✅ All enhanced workers tested successfully!');
    
  } catch (error) {
    console.error('❌ Worker test failed:', error.message);
    console.error(error);
  }
}

testWorkers();