/**
 * Example usage of the research module
 * This demonstrates how to use the researchTopic function for multi-source research
 */

import { researchTopic } from '../src/modules/research';
import { getMemory } from '../src/services/memory';

async function demonstrateResearch() {
  console.log('🔬 ARCANOS Research Module Example\n');
  
  // Set test mode for demonstration (in production, use real OpenAI API key)
  process.env.OPENAI_API_KEY = 'test_key_for_demo';
  
  console.log('Example 1: Research on Machine Learning');
  console.log('=====================================');
  
  const topic1 = 'machine learning fundamentals';
  const urls1 = [
    'https://en.wikipedia.org/wiki/Machine_learning',
    'https://www.ibm.com/topics/machine-learning',
    'https://www.coursera.org/learn/machine-learning'
  ];
  
  try {
    const insight1 = await researchTopic(topic1, urls1);
    console.log('✅ Research completed!');
    console.log('📝 Generated insight:', insight1);
    
    // Check stored data
    const summary = await getMemory(`research/${topic1}/summary`);
    console.log('💾 Stored summary metadata:', {
      topic: summary?.topic,
      sources: summary?.sources,
      hasInsight: !!summary?.insight
    });
    
    // Check individual sources
    for (let i = 1; i <= urls1.length; i++) {
      const source = await getMemory(`research/${topic1}/sources/${i}`);
      if (source) {
        console.log(`📄 Source ${i} stored: ${source.url}`);
      }
    }
    
  } catch (error: any) {
    console.error('❌ Research failed:', error.message);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  console.log('Example 2: Research with No URLs (Edge Case)');
  console.log('===========================================');
  
  const topic2 = 'blockchain technology';
  
  try {
    const insight2 = await researchTopic(topic2, []);
    console.log('✅ Empty URL research handled gracefully!');
    console.log('📝 Generated insight:', insight2);
    
  } catch (error: any) {
    console.error('❌ Empty URL research failed:', error.message);
  }
  
  console.log('\n' + '='.repeat(50) + '\n');
  
  console.log('API Endpoint Usage Example:');
  console.log('==========================');
  console.log('POST /commands/research');
  console.log('Content-Type: application/json\n');
  console.log(JSON.stringify({
    topic: "artificial intelligence ethics",
    urls: [
      "https://www.nature.com/articles/s41586-021-03819-2",
      "https://www.scientificamerican.com/article/ai-ethics/",
      "https://www.brookings.edu/research/algorithmic-bias-detection/"
    ]
  }, null, 2));
  
  console.log('\nExpected Response:');
  console.log(JSON.stringify({
    success: true,
    topic: "artificial intelligence ethics",
    insight: "Comprehensive research brief synthesized from multiple sources...",
    sourcesProcessed: 3
  }, null, 2));
  
  console.log('\n🏁 Research demonstration completed!');
  console.log('\nMemory Structure Created:');
  console.log('- research/{topic}/summary     -> Final synthesized insight');
  console.log('- research/{topic}/sources/1   -> Individual source summaries');
  console.log('- research/{topic}/sources/2   -> ...');
  console.log('- research/{topic}/sources/N   -> ...');
}

// Run the demonstration
if (require.main === module) {
  demonstrateResearch().catch(error => {
    console.error('Demonstration failed:', error);
    process.exit(1);
  });
}

export { demonstrateResearch };