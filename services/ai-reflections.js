/**
 * AI Reflections service for stateless patch generation
 * Builds patch sets without relying on memory orchestration
 */
import { reflect, coreAIService } from '../src/services/ai/index.js';
/**
 * Build a patch set using AI reflections without memory orchestration
 * Operates in stateless mode when useMemory is false
 */
export async function buildPatchSet(options = {}) {
    const { useMemory = true, includeSystemState = false, analysisDepth = 'comprehensive', targetArea = 'general' } = options;
    const patchSetId = `patch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    console.log(`🧠 Building patch set (ID: ${patchSetId})`);
    console.log(`📊 Memory orchestration: ${useMemory ? 'ENABLED' : 'BYPASSED'}`);
    // Generate reflection without memory dependency if requested
    let reflection;
    if (useMemory) {
        // Use standard reflection with memory persistence
        reflection = await reflect({
            label: `patch_reflection_${patchSetId}`,
            persist: true,
            includeStack: includeSystemState,
            commitIfChanged: false,
            targetPath: 'ai_outputs/patch_reflections/'
        });
    }
    else {
        // Stateless reflection - bypass memory orchestration
        console.log('🔄 Generating stateless reflection...');
        const reflectionMessages = [
            {
                role: 'system',
                content: `You are performing a stateless AI reflection for patch generation. Analyze the current system state and provide improvement recommendations. Focus on:
        1. Code optimization opportunities
        2. System performance improvements  
        3. Feature enhancements
        4. Bug fixes and stability improvements
        5. Architecture optimizations
        
        Generate specific, actionable improvements without relying on historical memory or previous context.
        Target area: ${targetArea}
        Analysis depth: ${analysisDepth}`
            },
            {
                role: 'user',
                content: `Generate a comprehensive reflection for patch creation. Current timestamp: ${timestamp}. Operate in stateless mode without memory dependencies.`
            }
        ];
        const aiResponse = await coreAIService.complete(reflectionMessages, 'stateless-patch-reflection', {
            maxTokens: 3000,
            temperature: 0.4
        });
        reflection = {
            label: `stateless_patch_reflection_${patchSetId}`,
            timestamp,
            reflection: aiResponse.content,
            systemState: includeSystemState ? {
                timestamp,
                memoryUsage: process.memoryUsage(),
                uptime: process.uptime(),
                nodeVersion: process.version,
                platform: process.platform
            } : undefined,
            targetPath: 'ai_outputs/stateless_patch_reflections/',
            metadata: {
                model: aiResponse.model,
                persist: false, // Stateless mode - don't persist
                includeStack: includeSystemState
            }
        };
    }
    // Generate improvement suggestions based on reflection
    const improvementMessages = [
        {
            role: 'system',
            content: `Based on the following AI reflection, generate specific improvement suggestions and actionable patches. Each suggestion should be:
      1. Specific and implementable
      2. Include priority level (low/medium/high)
      3. Provide clear implementation guidance
      4. Focus on concrete code or system changes`
        },
        {
            role: 'user',
            content: `Reflection content: ${reflection.reflection}

Generate 3-5 specific improvement suggestions with implementation details.`
        }
    ];
    const improvementsResponse = await coreAIService.complete(improvementMessages, 'patch-improvements', {
        maxTokens: 2000,
        temperature: 0.3
    });
    // Parse improvements from AI response
    const improvements = improvementsResponse.content
        .split('\n')
        .filter(line => line.trim().length > 0 && (line.includes('1.') || line.includes('2.') || line.includes('3.') || line.includes('4.') || line.includes('5.')))
        .map(line => line.replace(/^\d+\.\s*/, '').trim());
    // Generate patches based on improvements
    const patches = await generatePatches(improvements, analysisDepth);
    const patchSet = {
        id: patchSetId,
        timestamp,
        reflection,
        improvements,
        patches,
        metadata: {
            stateless: !useMemory,
            memoryBypass: !useMemory,
            generatedWithoutOrchestration: !useMemory
        }
    };
    console.log(`✅ Generated patch set with ${patches.length} patches`);
    console.log(`📝 Stateless mode: ${patchSet.metadata.stateless ? 'YES' : 'NO'}`);
    return patchSet;
}
/**
 * Generate specific patches based on improvement suggestions
 */
async function generatePatches(improvements, analysisDepth) {
    const patches = [];
    for (let i = 0; i < Math.min(improvements.length, 3); i++) {
        const improvement = improvements[i];
        const patchMessages = [
            {
                role: 'system',
                content: `Generate a specific code patch or configuration change for the following improvement. The patch should be:
        1. Ready to implement
        2. Include specific file paths or code snippets where applicable
        3. Provide clear implementation steps
        4. Be practical and achievable`
            },
            {
                role: 'user',
                content: `Improvement: ${improvement}

Generate a specific patch with implementation details.`
            }
        ];
        const patchResponse = await coreAIService.complete(patchMessages, 'patch-generation', {
            maxTokens: 1000,
            temperature: 0.2
        });
        // Determine priority based on content analysis
        const priority = determinePatchPriority(improvement, patchResponse.content);
        patches.push({
            content: patchResponse.content,
            description: improvement,
            priority
        });
    }
    return patches;
}
/**
 * Determine patch priority based on content analysis
 */
function determinePatchPriority(improvement, patchContent) {
    const highPriorityKeywords = ['security', 'performance', 'critical', 'bug', 'error', 'crash', 'memory leak'];
    const mediumPriorityKeywords = ['optimization', 'efficiency', 'refactor', 'improvement', 'enhancement'];
    const combinedText = `${improvement} ${patchContent}`.toLowerCase();
    if (highPriorityKeywords.some(keyword => combinedText.includes(keyword))) {
        return 'high';
    }
    if (mediumPriorityKeywords.some(keyword => combinedText.includes(keyword))) {
        return 'medium';
    }
    return 'low';
}
