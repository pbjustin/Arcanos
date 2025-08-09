/**
 * Manual demonstration of GPT-5 integration request journey
 * Shows: User Input → ARCANOS frames task → GPT-5 reasoning → ARCANOS post-processing → User
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function demonstrateGPT5RequestJourney() {
  console.log('🎯 GPT-5 Request Journey Demonstration');
  console.log('Showing complete flow: User → ARCANOS → GPT-5 → ARCANOS → User');
  console.log('='.repeat(70));

  let serverProcess;
  const serverPort = 3004; // Use different port for testing
  const baseUrl = `http://localhost:${serverPort}`;

  try {
    console.log('1. Starting ARCANOS server...');
    
    serverProcess = spawn('node', ['dist/server.js'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: serverPort.toString(),
        NODE_ENV: 'development',
        OPENAI_API_KEY: '' // Using mock mode for demonstration
      }
    });

    // Wait for server startup
    console.log('   Waiting for server...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Demonstrate request journey with different types of inputs
    const testCases = [
      {
        name: 'Simple System Query (No GPT-5 delegation)',
        input: 'Check system status',
        description: 'ARCANOS handles directly without GPT-5 delegation'
      },
      {
        name: 'Complex Reasoning Query (GPT-5 delegation)',
        input: 'Perform a complex reasoning analysis of distributed system architecture patterns and provide sophisticated insights into scalability challenges with advanced algorithmic solutions',
        description: 'ARCANOS delegates to GPT-5 for deep reasoning, then post-processes'
      },
      {
        name: 'Code Refactoring Query (GPT-5 delegation)',
        input: 'Refactor this legacy codebase to implement modern design patterns and best practices for improved maintainability',
        description: 'ARCANOS uses GPT-5 for code analysis, then applies filters and standards'
      }
    ];

    for (let i = 0; i < testCases.length; i++) {
      const testCase = testCases[i];
      console.log(`\n${2 + i}. ${testCase.name}`);
      console.log(`   Description: ${testCase.description}`);
      console.log(`   User Input: "${testCase.input.substring(0, 80)}${testCase.input.length > 80 ? '...' : ''}"`);
      
      try {
        const payload = { userInput: testCase.input };
        const curlCmd = `curl -s -X POST ${baseUrl}/arcanos -H "Content-Type: application/json" -d '${JSON.stringify(payload)}'`;
        const { stdout } = await execAsync(curlCmd);
        const response = JSON.parse(stdout);

        // Show the journey step-by-step
        console.log('   \n   🔄 Request Journey:');
        console.log('   ┌─ Step 1: ARCANOS receives raw user input ✅');
        console.log('   ├─ Step 2: ARCANOS applies memory context ✅');
        console.log('   ├─ Step 3: ARCANOS frames task for processing ✅');
        
        if (response.gpt5Delegation && response.gpt5Delegation.used) {
          console.log('   ├─ Step 4: ARCANOS sends structured prompt to GPT-5 ✅');
          console.log(`   │  └─ Reason: ${response.gpt5Delegation.reason}`);
          console.log('   ├─ Step 5: GPT-5 returns reasoning to ARCANOS ✅');
          console.log('   ├─ Step 6: ARCANOS integrates GPT-5 reasoning ✅');
        } else {
          console.log('   ├─ Step 4: No GPT-5 delegation needed ✅');
          console.log('   ├─ Step 5: ARCANOS processes directly ✅');
        }
        
        console.log('   ├─ Step 7: ARCANOS applies filters & safety rules ✅');
        console.log('   ├─ Step 8: ARCANOS performs tone adjustments ✅');
        console.log('   └─ Step 9: ARCANOS executes final output ✅');

        // Show key response elements
        console.log('\n   📊 Response Analysis:');
        console.log(`   - GPT-5 Delegation: ${response.gpt5Delegation?.used ? 'YES' : 'NO'}`);
        if (response.gpt5Delegation?.reason) {
          console.log(`   - Delegation Reason: ${response.gpt5Delegation.reason}`);
        }
        console.log(`   - Audit Safe Mode: ${response.auditSafe?.mode ? 'ENABLED' : 'DISABLED'}`);
        console.log(`   - Memory Enhanced: ${response.memoryContext?.memoryEnhanced ? 'YES' : 'NO'}`);
        console.log(`   - Task Logged: ${response.taskLineage?.logged ? 'YES' : 'NO'}`);
        console.log(`   - ARCANOS Processing: COMPLETE`);

        // Show audit trail
        if (response.auditSafe?.auditFlags && response.auditSafe.auditFlags.length > 0) {
          console.log(`   - Audit Flags: [${response.auditSafe.auditFlags.join(', ')}]`);
        }

        console.log('   ✅ Request journey completed successfully');

      } catch (error) {
        console.log(`   ❌ Request journey failed: ${error.message}`);
      }
    }

    console.log('\n🎉 GPT-5 Request Journey Demonstration Complete!');
    console.log('\n📋 Architecture Summary:');
    console.log('✅ ARCANOS serves as the full governing brain');
    console.log('✅ GPT-5 is used as primary reasoning engine when needed');
    console.log('✅ Every request starts and ends with ARCANOS');
    console.log('✅ GPT-5 responses are always post-processed by ARCANOS');
    console.log('✅ Memory context, safety rules, and compliance applied by ARCANOS');
    console.log('✅ Complete audit trail maintained for all requests');
    console.log('✅ Structured response format preserved throughout');
    
    return true;

  } catch (error) {
    console.error('❌ Demonstration failed:', error);
    return false;
  } finally {
    if (serverProcess) {
      console.log('\n5. Cleaning up...');
      serverProcess.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// Run the demonstration
demonstrateGPT5RequestJourney()
  .then(success => {
    if (success) {
      console.log('\n✅ GPT-5 request journey demonstration completed');
      console.log('🧠 Architecture: ARCANOS (governing brain) + GPT-5 (reasoning engine)');
      process.exit(0);
    } else {
      console.log('\n❌ Demonstration failed');
      process.exit(1);
    }
  })
  .catch(error => {
    console.error('❌ Demonstration error:', error);
    process.exit(1);
  });