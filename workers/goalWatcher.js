// AI-Controlled Goal Watcher Worker
// Monitors goals through ARCANOS model instructions
// Enhanced for sleep window with backlog audit functionality

const { modelControlHooks } = require('../dist/services/model-control-hooks');

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
        
        // Enhanced: Perform backlog audit during sleep window
        const { shouldReduceServerActivity } = require('../dist/services/sleep-config');
        if (shouldReduceServerActivity()) {
          await performBacklogAudit(goals, memories);
        }
      }
    } else {
      console.log('[AI-GOAL-WATCHER] AI denied goal monitoring operation:', result.error);
    }
    
  } catch (error) {
    console.error('[AI-GOAL-WATCHER] Error in AI-controlled goal watching:', error.message);
  }
};

/**
 * Perform comprehensive backlog audit during sleep window
 */
async function performBacklogAudit(goals, allMemories) {
  try {
    console.log('[AI-GOAL-WATCHER] 🔍 Performing backlog audit during sleep window');
    
    const auditData = {
      timestamp: new Date().toISOString(),
      totalGoals: goals.length,
      totalMemories: allMemories.length,
      sleepWindow: true,
      auditResults: {
        activeGoals: 0,
        completedGoals: 0,
        staleGoals: 0,
        unreferencedMemories: 0,
        orphanedTasks: []
      }
    };
    
    // Analyze goal status
    const now = Date.now();
    const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);
    
    goals.forEach(goal => {
      const goalTimestamp = new Date(goal.timestamp || goal.created_at || '1970-01-01').getTime();
      const goalStatus = goal.value?.status || 'unknown';
      
      if (goalStatus === 'completed') {
        auditData.auditResults.completedGoals++;
      } else if (goalTimestamp < oneWeekAgo && goalStatus !== 'completed') {
        auditData.auditResults.staleGoals++;
        auditData.auditResults.orphanedTasks.push({
          id: goal.id || goal.key,
          age: Math.floor((now - goalTimestamp) / (24 * 60 * 60 * 1000)),
          status: goalStatus
        });
      } else {
        auditData.auditResults.activeGoals++;
      }
    });
    
    // Find unreferenced memories (potential cleanup candidates)
    const goalRelatedMemories = allMemories.filter(memory => 
      memory.tags && (
        memory.tags.includes('goal') || 
        memory.tags.includes('task') || 
        memory.tags.includes('project')
      )
    );
    
    auditData.auditResults.unreferencedMemories = allMemories.length - goalRelatedMemories.length;
    
    // Store audit results
    const auditResult = await modelControlHooks.manageMemory(
      'store',
      {
        key: `backlog_audit_${new Date().toISOString().split('T')[0]}_${Date.now()}`,
        value: auditData,
        tags: ['audit', 'backlog', 'sleep', 'maintenance', 'goals']
      },
      {
        userId: 'system',
        sessionId: 'backlog-audit',
        source: 'worker'
      }
    );
    
    if (auditResult.success) {
      console.log('[AI-GOAL-WATCHER] ✅ Backlog audit completed successfully');
      console.log('[AI-GOAL-WATCHER] 📊 Audit results - Active: %d, Completed: %d, Stale: %d, Unreferenced: %d', 
        auditData.auditResults.activeGoals,
        auditData.auditResults.completedGoals,
        auditData.auditResults.staleGoals,
        auditData.auditResults.unreferencedMemories
      );
      
      if (auditData.auditResults.staleGoals > 0) {
        console.log('[AI-GOAL-WATCHER] ⚠️ Found %d stale goals that may need attention', auditData.auditResults.staleGoals);
      }
    } else {
      throw new Error(`Audit storage failed: ${auditResult.error}`);
    }
    
  } catch (error) {
    console.error('[AI-GOAL-WATCHER] ❌ Backlog audit failed:', error.message);
  }
}
