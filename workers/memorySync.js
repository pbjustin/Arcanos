// AI-Controlled Memory Sync Worker
// Executes only when approved by ARCANOS model
// Enhanced for sleep window with snapshot functionality

const { modelControlHooks } = require('../dist/services/model-control-hooks');

module.exports = async function memorySync() {
  console.log('[AI-MEMORY-SYNC] Starting AI-controlled memory sync');
  
  try {
    // Request permission from AI model
    const result = await modelControlHooks.manageMemory(
      'list',
      {},
      {
        userId: 'system',
        sessionId: 'memory-sync',
        source: 'worker'
      }
    );

    if (result.success) {
      console.log('[AI-MEMORY-SYNC] AI approved memory sync operation');
      
      // Perform memory sync operations as directed by AI
      const syncResult = await modelControlHooks.manageMemory(
        'store',
        {
          key: 'sync_timestamp',
          value: new Date().toISOString(),
          tags: ['system', 'sync']
        },
        {
          userId: 'system',
          sessionId: 'memory-sync',
          source: 'worker'
        }
      );

      if (syncResult.success) {
        console.log('[AI-MEMORY-SYNC] Memory sync completed successfully');
        
        // Enhanced: Create memory snapshot during sleep window
        const { shouldReduceServerActivity } = require('../dist/services/sleep-config');
        if (shouldReduceServerActivity()) {
          await createMemorySnapshot();
        }
      } else {
        console.error('[AI-MEMORY-SYNC] Memory sync failed:', syncResult.error);
      }
    } else {
      console.log('[AI-MEMORY-SYNC] AI denied memory sync operation:', result.error);
    }
    
  } catch (error) {
    console.error('[AI-MEMORY-SYNC] Error in AI-controlled memory sync:', error.message);
  }
};

/**
 * Create a detailed memory snapshot during sleep window
 */
async function createMemorySnapshot() {
  try {
    console.log('[AI-MEMORY-SYNC] 📸 Creating memory snapshot during sleep window');
    
    const memUsage = process.memoryUsage();
    const timestamp = new Date().toISOString();
    
    // Get current memory contents for analysis
    const memoryListResult = await modelControlHooks.manageMemory(
      'list',
      {},
      {
        userId: 'system',
        sessionId: 'memory-snapshot',
        source: 'worker'
      }
    );
    
    const snapshotData = {
      timestamp,
      processMemory: {
        rss: Math.round(memUsage.rss / 1024 / 1024), // MB
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memUsage.external / 1024 / 1024) // MB
      },
      memoryCount: memoryListResult.success ? (memoryListResult.results?.[0]?.result?.length || 0) : 0,
      sleepWindow: true,
      snapshotType: 'sleep_maintenance'
    };
    
    // Store snapshot
    const snapshotResult = await modelControlHooks.manageMemory(
      'store',
      {
        key: `memory_snapshot_${timestamp.split('T')[0]}_${Date.now()}`,
        value: snapshotData,
        tags: ['snapshot', 'sleep', 'maintenance', 'memory-analysis']
      },
      {
        userId: 'system',
        sessionId: 'memory-snapshot',
        source: 'worker'
      }
    );
    
    if (snapshotResult.success) {
      console.log('[AI-MEMORY-SYNC] ✅ Memory snapshot created successfully');
      console.log('[AI-MEMORY-SYNC] 📊 Memory stats - RSS: %dMB, Heap: %dMB/%dMB, Records: %d', 
        snapshotData.processMemory.rss,
        snapshotData.processMemory.heapUsed,
        snapshotData.processMemory.heapTotal,
        snapshotData.memoryCount
      );
    } else {
      throw new Error(`Snapshot storage failed: ${snapshotResult.error}`);
    }
    
  } catch (error) {
    console.error('[AI-MEMORY-SYNC] ❌ Memory snapshot failed:', error.message);
  }
}
