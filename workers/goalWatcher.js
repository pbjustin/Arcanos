// AI-Controlled Goal Watcher Worker
// Monitors goals through ARCANOS model instructions

const { modelControlHooks } = require('../src/services/model-control-hooks');

module.exports = async function goalWatcher() {
  console.log('[AI-GOAL-WATCHER] Starting AI-controlled goal monitoring');
  
  try {
    // Request goal monitoring from AI model
    const result = await modelControlHooks.manageMemory(
      'list',
      {},
      {
        userId: 'system',
        sessionId: 'goal-watcher',
        source: 'worker'
      }
    );

    if (result.success && result.results) {
      const memories = result.results[0]?.result || [];
      const goals = memories.filter(memory => 
        memory.tags && memory.tags.includes('goal')
      );
      
      console.log('[AI-GOAL-WATCHER] Found %d goals to monitor', goals.length);
      
      // Report goal status to AI model
      const reportResult = await modelControlHooks.performAudit(
        { goals: goals.length, timestamp: new Date().toISOString() },
        'goal_monitoring',
        {
          userId: 'system',
          sessionId: 'goal-watcher',
          source: 'worker'
        }
      );

      if (reportResult.success) {
        console.log('[AI-GOAL-WATCHER] Goal monitoring report sent to AI:', reportResult.response);
      }
    } else {
      console.log('[AI-GOAL-WATCHER] AI denied goal monitoring operation:', result.error);
    }
    
  } catch (error) {
    console.error('[AI-GOAL-WATCHER] Error in AI-controlled goal watching:', error.message);
  }
};
