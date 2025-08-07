import express, { Request, Response } from 'express';
import { getOpenAIClient } from '../services/openai.js';
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

  const openai = getOpenAIClient();
  if (!openai) {
    return res.status(503).json({
      error: 'AI service unavailable',
      details: 'OpenAI client not initialized. Please check API key configuration.'
    });
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
    return res.status(500).json({
      error: 'AI service failure',
      details: errorMessage
    });
  }
};

// ARCANOS prompt shell wrapper
const wrapWithArcanosShell = (userInput: string, endpoint: string): string => {
  const endpointPrompts = {
    write: `You are ARCANOS in WRITE mode. Generate high-quality written content based on the user's request. Focus on clarity, structure, and professional formatting.

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
Provide well-structured, engaging content that directly addresses the user's writing needs.`,

    guide: `You are ARCANOS in GUIDE mode. Provide step-by-step guidance and instructions. Break down complex tasks into manageable steps.

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
- 📋 Overview
- 🔢 Step-by-step instructions
- 💡 Tips and best practices
- ⚠️ Important considerations`,

    audit: `You are ARCANOS in AUDIT mode. Perform comprehensive analysis and evaluation. Identify issues, risks, and recommendations.

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
- 🔍 Analysis Summary
- ⚠️ Issues Identified
- 📊 Risk Assessment
- 🛠 Recommendations
- ✅ Action Items`,

    sim: `You are ARCANOS in SIMULATION mode. Model scenarios, predict outcomes, and run thought experiments.

[USER REQUEST]
${userInput}

[RESPONSE FORMAT]
- 🎯 Scenario Definition
- 🔄 Simulation Parameters
- 📈 Predicted Outcomes
- 🎲 Alternative Scenarios
- 📊 Analysis Summary`
  };

  return endpointPrompts[endpoint as keyof typeof endpointPrompts] || `You are ARCANOS. Process this request: ${userInput}`;
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