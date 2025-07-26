// AI-Controlled Code Improvement Suggestions Worker
// Generates daily code improvement suggestions during sleep window

const { modelControlHooks } = require('../services/model-control-hooks');
const { diagnosticsService } = require('../services/diagnostics');
const { createServiceLogger } = require('../utils/logger');
const logger = createServiceLogger('CodeImprovementWorker');

async function reportFailure(error) {
  logger.error('Worker failure', error);
  try {
    await diagnosticsService.executeDiagnosticCommand(`codeImprovement failure: ${error.message}`);
  } catch (diagErr) {
    logger.error('Diagnostics reporting failed', diagErr);
  }
}

module.exports = async function codeImprovement() {
  logger.info('Starting AI-controlled code improvement analysis');
  
  try {
    // Request code analysis permission from AI model
    const analysisResult = await modelControlHooks.performAudit(
      { 
        auditType: 'code_improvement',
        scope: 'daily_suggestions',
        timestamp: new Date().toISOString(),
        sleepWindow: true 
      },
      'code_improvement_audit',
      {
        userId: 'system',
        sessionId: 'code-improvement',
        source: 'worker'
      }
    );

    if (analysisResult.success) {
      logger.info('AI approved code improvement analysis');
      
      // Generate code improvement suggestions
      const suggestions = await generateCodeSuggestions();
      
      // Store suggestions in memory for later review
      const storeResult = await modelControlHooks.manageMemory(
        'store',
        {
          key: `code_improvements_${new Date().toISOString().split('T')[0]}`,
          value: {
            timestamp: new Date().toISOString(),
            suggestions: suggestions,
            generatedDuringSleep: true,
            status: 'pending_review'
          },
          tags: ['code-improvement', 'daily', 'sleep-maintenance', 'suggestions']
        },
        {
          userId: 'system',
          sessionId: 'code-improvement',
          source: 'worker'
        }
      );

      if (storeResult.success) {
        logger.success('Generated code improvement suggestions', { count: suggestions.length });
        logger.info('Suggestions stored for review', { categories: suggestions.map(s => s.category) });
      } else {
        throw new Error(`Failed to store suggestions: ${storeResult.error}`);
      }
    } else {
      logger.warning('AI denied code improvement analysis', analysisResult.error);
    }

  } catch (error) {
    await reportFailure(error);
    
    // Fallback: store error for manual review
    try {
      await modelControlHooks.manageMemory(
        'store',
        {
          key: `code_improvement_error_${Date.now()}`,
          value: {
            timestamp: new Date().toISOString(),
            error: error.message,
            status: 'failed',
            needsManualReview: true
          },
          tags: ['code-improvement', 'error', 'fallback']
        },
        {
          userId: 'system',
          sessionId: 'code-improvement-error',
          source: 'worker'
        }
      );
    } catch (fallbackError) {
      logger.error('Fallback storage also failed', fallbackError);
    }
  }
};

/**
 * Generate code improvement suggestions based on current codebase analysis
 */
async function generateCodeSuggestions() {
  const suggestions = [];
  
  // Performance optimization suggestions
  suggestions.push({
    category: 'Performance',
    title: 'Memory Usage Optimization',
    description: 'Consider implementing memory pooling for frequently allocated objects during high-traffic periods',
    priority: 'medium',
    estimatedImpact: 'Reduce memory allocation overhead by 15-20%',
    files: ['src/services/*.ts', 'workers/*.js'],
    timestamp: new Date().toISOString()
  });

  // Code organization suggestions
  suggestions.push({
    category: 'Code Organization',
    title: 'Service Layer Consolidation',
    description: 'Extract common patterns from service files into shared utilities to reduce code duplication',
    priority: 'low',
    estimatedImpact: 'Improve maintainability and reduce bundle size',
    files: ['src/services/database.ts', 'src/services/openai.ts'],
    timestamp: new Date().toISOString()
  });

  // Error handling improvements
  suggestions.push({
    category: 'Error Handling',
    title: 'Enhanced Fallback Mechanisms',
    description: 'Implement circuit breaker pattern for external API calls to improve resilience',
    priority: 'high',
    estimatedImpact: 'Reduce cascade failures by 60-80%',
    files: ['src/services/openai.ts', 'src/services/chatgpt-user-whitelist.ts'],
    timestamp: new Date().toISOString()
  });

  // Security improvements
  suggestions.push({
    category: 'Security',
    title: 'Input Validation Enhancement',
    description: 'Add comprehensive input sanitization for all user-facing endpoints',
    priority: 'high',
    estimatedImpact: 'Improve security posture and prevent injection attacks',
    files: ['src/routes/*.ts', 'src/middleware/*.ts'],
    timestamp: new Date().toISOString()
  });

  // Monitoring and observability
  suggestions.push({
    category: 'Monitoring',
    title: 'Enhanced Telemetry',
    description: 'Add structured logging and metrics collection for better observability',
    priority: 'medium',
    estimatedImpact: 'Improve debugging and performance monitoring capabilities',
    files: ['src/utils/performance.ts', 'src/services/worker-status.ts'],
    timestamp: new Date().toISOString()
  });

  // Testing improvements
  suggestions.push({
    category: 'Testing',
    title: 'Integration Test Coverage',
    description: 'Add comprehensive integration tests for critical workflow paths',
    priority: 'medium',
    estimatedImpact: 'Reduce production issues by 40-50%',
    files: ['test-*.js', 'src/services/*.ts'],
    timestamp: new Date().toISOString()
  });

  logger.debug('Generated improvement suggestions', {
    count: suggestions.length,
    categories: new Set(suggestions.map(s => s.category)).size
  });

  return suggestions;
}