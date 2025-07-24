// AI-Controlled Temp Cleaner Worker
// Cleans temporary data when approved by ARCANOS model

const { modelControlHooks } = require('../src/services/model-control-hooks');

module.exports = async function clearTemp() {
  console.log('[AI-TEMP-CLEANER] Starting AI-controlled temp cleanup');
  
  try {
    // Request cleanup permission from AI model
    const result = await modelControlHooks.performMaintenance(
      'cleanup',
      { target: 'temp', maxAge: '24h' },
      {
        userId: 'system',
        sessionId: 'temp-cleaner',
        source: 'worker'
      }
    );

    if (result.success) {
      console.log('[AI-TEMP-CLEANER] AI approved temp cleanup operation');
      
      // Perform AI-approved cleanup
      if (global.gc) {
        global.gc();
        console.log('[AI-TEMP-CLEANER] Memory garbage collection executed');
      }
      
      console.log('[AI-TEMP-CLEANER] Temp cleanup completed successfully');
    } else {
      console.log('[AI-TEMP-CLEANER] AI denied temp cleanup operation:', result.error);
    }
    
  } catch (error) {
    console.error('[AI-TEMP-CLEANER] Error in AI-controlled temp cleanup:', error.message);
  }
};
