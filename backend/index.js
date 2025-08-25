import express from "express";
import OpenAI from "openai";
import dotenv from "dotenv";

// Load API key from .env
dotenv.config();

const app = express();
app.use(express.json());

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ARCANOS fine-tuned model (primary)
const ARCANOS_MODEL = "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote";
const GPT5_MODEL = "gpt-5";
const FALLBACK_MODEL = "gpt-4";

/**
 * Enhanced GPT-5 reasoning layer for refining ARCANOS responses
 */
async function applyGPT5ReasoningLayer(arcanosResult, originalPrompt) {
  try {
    console.log('🔄 [GPT-5 LAYER] Refining ARCANOS response...');
    
    const reasoningPrompt = `As an advanced reasoning engine, analyze and refine the following ARCANOS response:

ORIGINAL USER REQUEST:
${originalPrompt}

ARCANOS RESPONSE:
${arcanosResult}

Your task:
1. Evaluate the logical consistency and completeness of the ARCANOS response
2. Identify any gaps in reasoning or potential improvements  
3. Provide a refined, enhanced version that maintains ARCANOS's core analysis while adding deeper insights
4. Ensure the response is well-structured and comprehensive

Return only the refined response without meta-commentary about your analysis process.`;

    const response = await openai.chat.completions.create({
      model: GPT5_MODEL,
      messages: [
        { 
          role: "system", 
          content: "You are an advanced reasoning layer for ARCANOS AI. Your role is to refine and enhance ARCANOS responses through deeper analysis while preserving the original intent and structure." 
        },
        { role: "user", content: reasoningPrompt }
      ],
      max_completion_tokens: 1500,
      temperature: 0.7
    });

    const refinedResult = response.choices[0].message.content;
    console.log('✅ [GPT-5 LAYER] Successfully refined response');
    
    return {
      result: refinedResult,
      reasoningUsed: true,
      originalArcanosResult: arcanosResult
    };
  } catch (error) {
    console.warn('⚠️ [GPT-5 LAYER] Failed, using original ARCANOS result:', error.message);
    return {
      result: arcanosResult,
      reasoningUsed: false,
      error: error.message
    };
  }
}

/**
 * Enhanced fallback handling: ARCANOS → retry → GPT-5 → GPT-4
 */
async function createCompletionWithFallback(messages) {
  // First attempt: Fine-tuned ARCANOS model
  try {
    console.log(`🧠 [PRIMARY] Using ARCANOS model: ${ARCANOS_MODEL}`);
    const response = await openai.chat.completions.create({
      model: ARCANOS_MODEL,
      messages: messages
    });
    
    return {
      response,
      activeModel: ARCANOS_MODEL,
      fallbackUsed: false
    };
  } catch (primaryError) {
    console.warn('⚠️ [PRIMARY] ARCANOS model failed:', primaryError.message);
    
    // Retry attempt: Try ARCANOS model once more
    try {
      console.log('🔄 [RETRY] Retrying ARCANOS model...');
      const retryResponse = await openai.chat.completions.create({
        model: ARCANOS_MODEL,
        messages: messages
      });
      
      return {
        response: retryResponse,
        activeModel: ARCANOS_MODEL,
        fallbackUsed: false,
        retryUsed: true
      };
    } catch (retryError) {
      console.warn('⚠️ [RETRY] ARCANOS retry failed:', retryError.message);
      
      // GPT-5 fallback attempt
      try {
        console.log(`🚀 [GPT-5 FALLBACK] Using ${GPT5_MODEL}`);
        const gpt5Response = await openai.chat.completions.create({
          model: GPT5_MODEL,
          messages: messages,
          max_completion_tokens: 1024
        });
        
        return {
          response: gpt5Response,
          activeModel: GPT5_MODEL,
          fallbackUsed: true,
          fallbackReason: 'ARCANOS model failed twice'
        };
      } catch (gpt5Error) {
        console.warn('⚠️ [GPT-5 FALLBACK] GPT-5 failed:', gpt5Error.message);
        
        // Final fallback: GPT-4
        try {
          console.log(`🛟 [FINAL FALLBACK] Using ${FALLBACK_MODEL}`);
          const finalResponse = await openai.chat.completions.create({
            model: FALLBACK_MODEL,
            messages: messages
          });
          
          return {
            response: finalResponse,
            activeModel: FALLBACK_MODEL,
            fallbackUsed: true,
            fallbackReason: 'All models failed: ARCANOS, GPT-5'
          };
        } catch (finalError) {
          throw new Error(`All models failed: ${finalError.message}`);
        }
      }
    }
  }
}

// Enhanced route with GPT-5 reasoning layer and proper fallback
app.post("/arcanos", async (req, res) => {
  try {
    const { prompt, useReasoningLayer = true } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const messages = [
      { role: "system", content: "You are ARCANOS, an advanced AI logic engine." },
      { role: "user", content: prompt }
    ];

    // Get response with fallback handling
    const completionResult = await createCompletionWithFallback(messages);
    const arcanosResult = completionResult.response.choices[0].message.content;

    // Apply GPT-5 reasoning layer if requested and model is ARCANOS
    let finalResult = arcanosResult;
    let reasoningInfo = { reasoningUsed: false };

    if (useReasoningLayer && completionResult.activeModel === ARCANOS_MODEL) {
      const reasoningResult = await applyGPT5ReasoningLayer(arcanosResult, prompt);
      finalResult = reasoningResult.result;
      reasoningInfo = {
        reasoningUsed: reasoningResult.reasoningUsed,
        originalArcanosResult: reasoningResult.originalArcanosResult,
        reasoningError: reasoningResult.error
      };
    }

    res.json({
      reply: finalResult,
      meta: {
        activeModel: completionResult.activeModel,
        fallbackUsed: completionResult.fallbackUsed,
        retryUsed: completionResult.retryUsed || false,
        fallbackReason: completionResult.fallbackReason,
        tokens: completionResult.response.usage || {},
        ...reasoningInfo
      }
    });

  } catch (error) {
    console.error('❌ [ERROR]', error);
    res.status(500).json({ 
      error: error.message,
      type: 'server_error'
    });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "ARCANOS Backend",
    models: {
      primary: ARCANOS_MODEL,
      reasoning: GPT5_MODEL,
      fallback: FALLBACK_MODEL
    },
    timestamp: new Date().toISOString()
  });
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Enhanced ARCANOS backend running on port ${PORT}`);
  console.log(`🧠 Primary Model: ${ARCANOS_MODEL}`);
  console.log(`🚀 Reasoning Layer: ${GPT5_MODEL}`);
  console.log(`🛟 Fallback Model: ${FALLBACK_MODEL}`);
});