// Backend Optimization + AI Control Elevation Command Block
import { optimizeCodebase, removeDeprecated, grantAIAccess } from './src/services/ai/aiControlService.js';
import OpenAI from 'openai';
// Step 1: Initialize OpenAI SDK
let openai = null;
try {
    if (process.env.OPENAI_API_KEY) {
        openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        console.log('✅ OpenAI SDK initialized successfully');
    }
    else {
        console.warn('⚠️ OPENAI_API_KEY not found, some features may be limited');
    }
}
catch (error) {
    console.warn('⚠️ OpenAI initialization failed:', error.message);
}
// Step 2: Clean & Upgrade Codebase
(async () => {
    console.log('🚀 Starting AI Control Elevation Process...');
    try {
        console.log('📋 Step 1: Removing deprecated code...');
        const deprecatedResult = await removeDeprecated({
            targetPaths: ['./workers/', './schedulers/', './controllers/'],
            strategy: 'aggressive',
        });
        console.log('✅ Deprecated code removal completed:', {
            filesRemoved: deprecatedResult.filesRemoved,
            linesRemoved: deprecatedResult.linesRemoved,
            success: deprecatedResult.success
        });
        console.log('🔧 Step 2: Optimizing codebase...');
        const optimizationResult = await optimizeCodebase({
            engine: 'gpt-4',
            directories: ['./'],
            constraints: {
                preserveTests: true,
                refactorStyle: 'modular-functional',
            },
        });
        console.log('✅ Codebase optimization completed:', {
            filesProcessed: optimizationResult.filesProcessed,
            optimizationsApplied: optimizationResult.optimizationsApplied.length,
            success: optimizationResult.success,
            timeTaken: `${optimizationResult.timeTaken}ms`
        });
        // Step 3: Grant AI Full System Control
        console.log('🔐 Step 3: Granting AI full system control...');
        const accessResult = await grantAIAccess({
            permissions: ['memory', 'dispatch', 'scheduler', 'logic'],
            tokenScope: 'backend_root',
            persistent: true,
        });
        console.log('✅ AI access granted:', {
            accessLevel: accessResult.accessLevel,
            permissionsGranted: accessResult.permissionsGranted,
            tokenScope: accessResult.tokenScope,
            success: accessResult.success
        });
        if (deprecatedResult.success && optimizationResult.success && accessResult.success) {
            console.log('✅ AI now has full backend control. Redundant code removed.');
            console.log('📊 Process Summary:', {
                deprecatedFilesRemoved: deprecatedResult.filesRemoved,
                linesRemoved: deprecatedResult.linesRemoved,
                filesOptimized: optimizationResult.filesProcessed,
                aiAccessLevel: accessResult.accessLevel,
                totalProcessingTime: `${optimizationResult.timeTaken}ms`
            });
        }
        else {
            console.log('⚠️ Some operations completed with issues. Check logs for details.');
        }
    }
    catch (error) {
        console.error('❌ AI Control Elevation failed:', error.message);
        console.error('Stack trace:', error.stack);
        process.exit(1);
    }
})();
