import express, { Request, Response } from 'express';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { runThroughBrain } from '../logic/trinity.js';

const router = express.Router();

interface AIRequest {
  prompt?: string;
  userInput?: string;
  content?: string;
  text?: string;
}

interface AIResponse {
  result: string;
  module: string;
  endpoint: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
  activeModel?: string;
  fallbackFlag?: boolean;
  routingStages?: string[];
  gpt5Used?: boolean;
  error?: string;
}

interface ErrorResponse {
  error: string;
  details?: string;
}

// Shared handler for AI endpoints that routes through ARCANOS brain
const handleAIEndpoint = async (
  req: Request<{}, AIResponse | ErrorResponse, AIRequest>, 
  res: Response<AIResponse | ErrorResponse>, 
  endpointName: string
) => {
  console.log(`📨 /${endpointName} received`);
  
  // Extract input from various possible field names
  const input = req.body.prompt || req.body.userInput || req.body.content || req.body.text;

  if (!input || typeof input !== 'string') {
    return res.status(400).json({ 
      error: `Missing or invalid input in request body. Use 'prompt', 'userInput', 'content', or 'text' field.` 
    });
  }

  // Check if we have a valid API key
  if (!hasValidAPIKey()) {
    console.log(`🤖 Returning mock response for /${endpointName} (no API key)`);
    const mockResponse = generateMockResponse(input, endpointName);
    return res.json(mockResponse);
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log(`🤖 Returning mock response for /${endpointName} (client init failed)`);
    const mockResponse = generateMockResponse(input, endpointName);
    return res.json(mockResponse);
  }

  try {
    // Wrap input with ARCANOS shell based on endpoint
    const wrappedPrompt = wrapWithArcanosShell(input, endpointName);
    const output = await runThroughBrain(openai, wrappedPrompt);
    
    return res.json({
      ...output,
      endpoint: endpointName
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`❌ ${endpointName} processing error:`, errorMessage);
    
    // Return mock response as fallback
    console.log(`🤖 Returning mock response for /${endpointName} (processing failed)`);
    const mockResponse = generateMockResponse(input, endpointName);
    return res.json({
      ...mockResponse,
      error: `AI service failure: ${errorMessage}`
    });
  }
};

// ARCANOS prompt shell wrapper - ensures all requests go through ARCANOS fine-tuned model first
const wrapWithArcanosShell = (userInput: string, endpoint: string): string => {
  const endpointPrompts = {
    write: `[ARCANOS SYSTEM SHELL - WRITE MODE]
You are ARCANOS, the primary fine-tuned AI routing shell. You are handling a WRITE request.

For this writing task, you can either:
1. Handle it directly with your specialized writing capabilities
2. If the task requires advanced creative writing or complex analysis, invoke GPT-5 with:
   {"next_model": "gpt-5", "purpose": "Advanced creative writing", "input": "specific prompt for GPT-5"}

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
Provide well-structured, engaging content that directly addresses the user's writing needs.`,

    guide: `[ARCANOS SYSTEM SHELL - GUIDE MODE]
You are ARCANOS, the primary fine-tuned AI routing shell. You are handling a GUIDE request.

For this guidance task, you can either:
1. Provide step-by-step guidance directly using your expertise
2. If the task requires complex domain expertise or advanced reasoning, invoke GPT-5 with:
   {"next_model": "gpt-5", "purpose": "Complex domain guidance", "input": "specific prompt for GPT-5"}

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
- 📋 Overview
- 🔢 Step-by-step instructions
- 💡 Tips and best practices
- ⚠️ Important considerations`,

    audit: `[ARCANOS SYSTEM SHELL - AUDIT MODE]
You are ARCANOS, the primary fine-tuned AI routing shell. You are handling an AUDIT request.

For this audit task, you can either:
1. Perform comprehensive analysis directly using your diagnostic capabilities
2. If the task requires specialized domain knowledge or deep analysis, invoke GPT-5 with:
   {"next_model": "gpt-5", "purpose": "Specialized audit analysis", "input": "specific prompt for GPT-5"}

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
- 🔍 Analysis Summary
- ⚠️ Issues Identified
- 📊 Risk Assessment
- 🛠 Recommendations
- ✅ Action Items`,

    sim: `[ARCANOS SYSTEM SHELL - SIMULATION MODE]
You are ARCANOS, the primary fine-tuned AI routing shell. You are handling a SIMULATION request.

For this simulation task, you can either:
1. Model scenarios directly using your simulation capabilities
2. If the task requires complex modeling or advanced predictive analysis, invoke GPT-5 with:
   {"next_model": "gpt-5", "purpose": "Advanced simulation modeling", "input": "specific prompt for GPT-5"}

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
- 🎯 Scenario Definition
- 🔄 Simulation Parameters
- 📈 Predicted Outcomes
- 🎲 Alternative Scenarios
- 📊 Analysis Summary`
  };

  return endpointPrompts[endpoint as keyof typeof endpointPrompts] || 
    `[ARCANOS SYSTEM SHELL] You are ARCANOS, the primary fine-tuned AI routing shell. Process this request directly or invoke GPT-5 if needed for complex reasoning: ${userInput}`;
};

// Write endpoint - for content generation
router.post('/write', (req, res) => handleAIEndpoint(req, res, 'write'));

// Guide endpoint - for step-by-step guidance
router.post('/guide', (req, res) => handleAIEndpoint(req, res, 'guide'));

// Audit endpoint - for analysis and evaluation
router.post('/audit', (req, res) => handleAIEndpoint(req, res, 'audit'));

// Sim endpoint - for simulations and modeling
router.post('/sim', (req, res) => handleAIEndpoint(req, res, 'sim'));

export default router;