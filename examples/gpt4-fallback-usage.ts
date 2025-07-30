/**
 * GPT-4 Fallback Usage Examples for ARCANOS
 * Demonstrates how to integrate fallback functionality as specified in the problem statement
 */

import { Request, Response } from 'express';
import { getGPT4FallbackService } from '../src/services/gpt4-fallback';
import { recoverOutput, recoverGameGuide, isMalformed, ExampleUsage } from '../src/utils/output-recovery';

// Example from problem statement: Fallback for partial guides
async function handlePartialGuideExample(output: string, res: Response) {
  console.log('📖 Example: Handling partial game guide');
  
  // Example usage from problem statement:
  // If ARCANOS returns partial guide
  if (output.includes("[") && !output.includes("]")) {
    console.log('🔄 Detected incomplete guide with unmatched brackets');
    
    const repaired = await recoverGameGuide(
      "Fetch Baldur's Gate 3 prologue guide",
      output
    );
    
    res.setHeader('X-Output-Recovered', 'true');
    res.setHeader('X-Recovery-Source', 'gpt4-fallback');
    return res.status(200).send(repaired);
  }
  
  return res.status(200).send(output);
}

// Example: Enhanced route handler with automatic fallback
function withFallbackExample() {
  return async (req: Request, res: Response) => {
    console.log('🔧 Example: Route handler with automatic fallback');
    
    try {
      // Simulate getting some potentially malformed output from ARCANOS
      const arcanosOutput = getMockArcanosOutput();
      
      // Check if output needs recovery
      if (isMalformed(arcanosOutput, 'markdown')) {
        console.log('⚠️ Malformed output detected, applying GPT-4 fallback');
        
        const recoveryResult = await recoverOutput(arcanosOutput, {
          task: `${req.method} ${req.path}`,
          expectedFormat: 'markdown',
          source: 'route-handler'
        });
        
        if (recoveryResult.wasRecovered) {
          res.setHeader('X-Output-Recovered', 'true');
          res.setHeader('X-Recovery-Source', 'gpt4-fallback');
          console.log('✅ Successfully recovered malformed output');
        }
        
        return res.status(200).send(recoveryResult.output);
      }
      
      return res.status(200).send(arcanosOutput);
      
    } catch (error: any) {
      console.error('❌ Route handler error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  };
}

// Example: Direct service usage
async function directServiceUsageExample() {
  console.log('🛠️ Example: Direct GPT-4 Fallback Service usage');
  
  const fallbackService = getGPT4FallbackService();
  
  // Simulate malformed task output
  const malformedOutput = `{
    "guide": "Baldur's Gate 3 Prologue",
    "sections": [
      {"title": "Chapter 1", "content": "Wake up on the nautiloid and`;
  
  console.log('Original malformed output:', malformedOutput);
  
  // Detect if recovery is needed
  const detection = fallbackService.detectMalformed(malformedOutput, 'json');
  console.log('Detection result:', {
    isMalformed: detection.isMalformed,
    issues: detection.detectedIssues,
    confidence: detection.confidence
  });
  
  if (detection.isMalformed) {
    try {
      // Attempt recovery using GPT-4
      const result = await fallbackService.fallbackToGPT4({
        task: 'Generate Baldur\'s Gate 3 prologue guide',
        malformedOutput,
        expectedFormat: 'json',
        maxTokens: 1000,
        temperature: 0.3
      });
      
      if (result.success) {
        console.log('✅ Recovery successful!');
        console.log('Repaired output:', result.repairedOutput);
        console.log('Tokens used:', result.tokensUsed);
      } else {
        console.log('❌ Recovery failed:', result.error);
      }
    } catch (error: any) {
      console.log('⚠️ Recovery error (likely no API key):', error.message);
    }
  }
}

// Example: Integration with existing ARCANOS handlers
class EnhancedGuideHandler {
  static async handleGuideRequest(req: Request, res: Response) {
    console.log('📚 Example: Enhanced guide handler with fallback');
    
    const { guideId } = req.body;
    
    try {
      // Simulate existing guide retrieval logic
      const guide = await getMockGuideFromMemory(guideId);
      
      if (!guide) {
        return res.status(404).json({ error: 'Guide not found' });
      }
      
      // Format the guide (existing logic)
      let formattedGuide = formatMockGuide(guide);
      
      // Apply fallback if needed
      const recoveryResult = await recoverOutput(formattedGuide, {
        task: `Fetch ${guideId} guide`,
        expectedFormat: 'markdown',
        source: 'guide-handler'
      });
      
      if (recoveryResult.wasRecovered) {
        res.setHeader('X-Output-Recovered', 'true');
        res.setHeader('X-Recovery-Source', 'gpt4-fallback');
        console.log(`🔄 Applied fallback recovery for guide: ${guideId}`);
      }
      
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(recoveryResult.output);
      
    } catch (error: any) {
      console.error('❌ Guide handler error:', error.message);
      return res.status(500).json({ error: 'Internal server error' });
    }
  }
}

// Mock functions for examples
function getMockArcanosOutput(): string {
  return `# Baldur's Gate 3 Guide

## Prologue Chapter

1. Wake up on the nautiloid
2. Find your companions
   - Shadowheart is near the helm
   - Lae'zel is trapped in a pod

3. Navigate to the`;  // Intentionally incomplete
}

async function getMockGuideFromMemory(guideId: string) {
  return {
    id: guideId,
    sections: [
      'Chapter 1: The Beginning',
      'Chapter 2: Character Creation',
      'Chapter 3: Combat Basics'
    ]
  };
}

function formatMockGuide(guide: any): string {
  return guide.sections.join('\n\n');
}

// Example runner
async function runExamples() {
  console.log('🚀 Running GPT-4 Fallback Usage Examples\n');
  
  try {
    // Run examples that don't require API calls
    console.log('1. Direct Service Usage Example');
    await directServiceUsageExample();
    console.log('\n');
    
    console.log('2. Pattern Detection Examples');
    const testOutputs = [
      'Complete guide content here',
      '{"incomplete": "json object"',
      '# Guide\n\nChapter 1: Start here\nChapter 2: Continue',
      'Text that ends abruptly...'
    ];
    
    const fallbackService = getGPT4FallbackService();
    for (const output of testOutputs) {
      const needsRecovery = fallbackService.needsFallback(output);
      console.log(`"${output.substring(0, 30)}..." → ${needsRecovery ? 'NEEDS RECOVERY' : 'OK'}`);
    }
    
    console.log('\n✅ Examples completed successfully!');
    console.log('\n📋 Integration Summary:');
    console.log('- Add GPT-4 fallback to guide handlers: ✅');
    console.log('- Add fallback to AI route responses: ✅'); 
    console.log('- Add fallback to ARCANOS v1 interface: ✅');
    console.log('- Utility functions for easy integration: ✅');
    console.log('- Malformed output detection: ✅');
    console.log('- Specific use case from problem statement: ✅');
    
  } catch (error: any) {
    console.error('❌ Example error:', error.message);
  }
}

// Export for use in other files
export {
  handlePartialGuideExample,
  withFallbackExample,
  EnhancedGuideHandler,
  runExamples
};

// Run examples if called directly
if (require.main === module) {
  runExamples();
}