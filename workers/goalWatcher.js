// AI-Controlled Goal Watcher Worker
// Monitors goals through ARCANOS model instructions
// Enhanced for sleep window with backlog audit functionality

const { diagnosticsService } = require('../dist/services/diagnostics');
const { createServiceLogger } = require('../dist/utils/logger');
const { checkModelControlHooks } = require('../dist/utils/overlay-diagnostics');
const logger = createServiceLogger('GoalWatcherWorker');

async function reportFailure(error) {
  logger.error('Worker failure', error);
  try {
    await diagnosticsService.executeDiagnosticCommand(`goalWatcher failure: ${error.message}`);
  } catch (diagErr) {
    logger.error('Diagnostics reporting failed', diagErr);
  }
}

module.exports = async function goalWatcher() {
  logger.info('Starting AI-controlled goal monitoring');

  try {
    const hooksOk = await checkModelControlHooks();
    let modelControlHooks;
    if (hooksOk) {
      ({ modelControlHooks } = require('../dist/services/model-control-hooks'));
    } else {
      logger.warning('Overlay reroute executed - skipping goal monitoring');
      return;
    }

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
      
      logger.info('Found goals to monitor', { count: goals.length });
      
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
        logger.success('Goal monitoring report sent to AI', { response: reportResult.response });
        
        // Enhanced: Perform backlog audit during sleep window
        const { shouldReduceServerActivity } = require('../dist/services/sleep-config');
        if (shouldReduceServerActivity()) {
          await performBacklogAudit(goals, memories);
        }
      }
    } else {
      logger.warning('AI denied goal monitoring operation', result.error);
    }
    
  } catch (error) {
    await reportFailure(error);
  }
};

/**
 * Perform comprehensive backlog audit during sleep window
 */
async function performBacklogAudit(goals, allMemories) {
  try {
    logger.info('Performing backlog audit during sleep window');
    
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
      logger.success('Backlog audit completed successfully', {
        active: auditData.auditResults.activeGoals,
        completed: auditData.auditResults.completedGoals,
        stale: auditData.auditResults.staleGoals,
        unreferenced: auditData.auditResults.unreferencedMemories
      });
      
      if (auditData.auditResults.staleGoals > 0) {
        logger.warning('Found stale goals that may need attention', { count: auditData.auditResults.staleGoals });
      }
    } else {
      throw new Error(`Audit storage failed: ${auditResult.error}`);
    }

  } catch (error) {
    await reportFailure(error);
  }
}
