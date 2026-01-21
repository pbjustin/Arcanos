/**
 * Test script for research module
 * Validates multi-source research functionality with URL fetching, summarization, and memory storage
 */

import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';

type ResearchResult = {
  topic: string;
  insight: string;
  sourcesProcessed: number;
  sources: Array<{ url: string; summary: string }>;
  failedUrls: string[];
};

type ResearchDeps = {
  researchTopic: (topic: string, urls?: string[]) => Promise<ResearchResult>;
  getMemory: <T = any>(key: string) => Promise<T | null>;
};

async function loadResearchDependencies(): Promise<ResearchDeps> {
  try {
    const [{ researchTopic }, { getMemory }] = await Promise.all([
      import('../dist/modules/research.js'),
      import('../dist/services/memory.js')
    ]);

    return { researchTopic, getMemory };
  } catch (error: any) {
    const isMissingDist = error?.code === 'ERR_MODULE_NOT_FOUND';

    if (isMissingDist) {
      console.log('ℹ️ Compiled dist files not found. Running `npm run build` to generate them...');
      const buildResult = spawnSync('npm', ['run', 'build'], { stdio: 'inherit' });

      if (buildResult.status !== 0) {
        throw new Error('Failed to build project before running research tests.');
      }

      const [{ researchTopic }, { getMemory }] = await Promise.all([
        import('../dist/modules/research.js'),
        import('../dist/services/memory.js')
      ]);

      return { researchTopic, getMemory };
    }

    throw error;
  }
}

process.env.OPENAI_API_KEY = 'test_key_for_mocking';

async function runResearchTests() {
  console.log('🔬 Running Research Module Tests\n');

  const { researchTopic, getMemory } = await loadResearchDependencies();

  // Test 1: Basic research function with mock URLs (test mode)
  console.log('Test 1: Basic research function (test mode)');
  try {
    const topic = 'artificial intelligence';
    const testUrls = [
      'https://en.wikipedia.org/wiki/Artificial_intelligence',
      'https://www.nature.com/articles/ai-research'
    ];

    const result = await researchTopic(topic, testUrls);

    if (result && result.insight.includes('Mock research brief')) {
      console.log('✅ Basic research test passed (test mode)');
      console.log('Generated insight preview:', result.insight.substring(0, 150) + '...\n');
    } else {
      console.log('⚠️ Research function returned unexpected result:', result);
    }
  } catch (error: any) {
    console.log('❌ Basic research test failed:', error.message);
  }

  // Test 2: Verify memory storage structure
  console.log('Test 2: Memory storage verification');
  try {
    const topic = 'machine learning';
    const testUrls = ['https://example.com/ml-guide'];
    
    const result = await researchTopic(topic, testUrls);

    // Check if summary was stored
    const summaryMemory = await getMemory(`research/${topic}/summary`);

    if (summaryMemory && summaryMemory.topic === topic) {
      console.log('✅ Research summary stored correctly');
      console.log('Summary data:', {
        topic: summaryMemory.topic,
        sources: summaryMemory.sources,
        hasInsight: !!summaryMemory.insight,
        failedUrls: summaryMemory.failedUrls
      });
    } else {
      console.log('⚠️ Research summary not found or malformed');
    }

    const sourceMemory = await getMemory(`research/${topic}/sources/1`);
    if (sourceMemory) {
      console.log('ℹ️ Source memory stored:', sourceMemory.url);
    } else {
      console.log('ℹ️ No source data stored (expected in test mode when URLs are unreachable)');
    }

    console.log('');
  } catch (error: any) {
    console.log('❌ Memory storage test failed:', error.message);
  }

  // Test 3: Empty URLs array
  console.log('Test 3: Empty URLs array handling');
  try {
    const topic = 'quantum computing';
    const result = await researchTopic(topic, []);

    if (result && result.sourcesProcessed === 0) {
      console.log('✅ Empty URLs array handled correctly');
      console.log('Result:', result.insight.substring(0, 100) + '...\n');
    } else {
      console.log('⚠️ Empty URLs array not handled as expected:', result);
    }
  } catch (error: any) {
    console.log('❌ Empty URLs array test failed:', error.message);
  }

  // Test 4: Error handling for invalid URLs
  console.log('Test 4: Invalid URL error handling');
  try {
    const topic = 'blockchain';
    const invalidUrls = ['not-a-url', 'http://nonexistent-domain-xyz123.com'];
    
    const result = await researchTopic(topic, invalidUrls);

    if (result) {
      console.log('✅ Invalid URLs handled gracefully');
      console.log('Failed URLs:', result.failedUrls);
    } else {
      console.log('⚠️ Invalid URL handling failed');
    }
  } catch (error: any) {
    console.log('❌ Invalid URL error handling test failed:', error.message);
  }

  console.log('🏁 Research module tests completed!');
}

// Handle direct execution
const invokedFromCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;

if (invokedFromCli) {
  runResearchTests().catch(error => {
    console.error('Test execution failed:', error);
    process.exit(1);
  });
}

export { runResearchTests };