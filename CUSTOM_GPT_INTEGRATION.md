# ARCANOS Custom GPT Integration Guide

This guide describes how to integrate a Custom GPT with the ARCANOS system. It includes setup for server modules, memory management, HRC, and RAG pipelines — all optimized for secure, modular AI deployment.

## Table of Contents

- [🧠 ARCANOS Modular Overview](#-arcanos-modular-overview)
- [📡 Endpoint Architecture](#-endpoint-architecture)
- [⚙️ OpenAI Custom GPT Instructions](#️-openai-custom-gpt-instructions)
- [🎛️ Custom GPT Actions Configuration](#️-custom-gpt-actions-configuration)
- [🔗 Fine-Tuned Model Integration](#-fine-tuned-model-integration)
- [🔐 Token + Authorization](#-token--authorization)
- [🛠 Deployment Note](#-deployment-note)
- [📁 Related Files](#-related-files)
- [✅ Status](#-status)
- [🧩 Contribute](#-contribute)

⸻

## 🧠 ARCANOS Modular Overview

ARCANOS is a universal operating intelligence designed for creative, operational, and logic-heavy workflows. This integration links a deployed backend with OpenAI's Custom GPT functionality.

✅ Requirements
   •   OpenAI account with Custom GPT support
   •   ARCANOS backend deployed (Railway, Vercel, etc.)
   •   Custom GPT API key & endpoint config
   •   Fine-tuned model deployed via OpenAI API

⸻

## 📡 Endpoint Architecture

Available APIs:

Available APIs:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | POST | Main chat with intent routing |
| `/api/ask` | POST | Fine-tuned model chat (no fallback) |
| `/api/ask-with-fallback` | POST | Chat with GPT fallback permission |
| `/api/ask-v1-safe` | POST | Safe interface with RAG/HRC features |
| `/api/arcanos` | POST | Intent-based routing (WRITE/AUDIT) |
| `/memory/save` | POST | Store memory entries |
| `/memory/load` | GET | Retrieve memory entries |
| `/memory/all` | GET | Get all memory entries |
| `/api/ask-hrc` | POST | Message validation using HRCCore overlay system |
| `/api/diagnostics` | POST | Natural language system diagnostics |
| `/api/canon/files` | GET/POST | Canon storyline file management |
| `/health` | GET | Health check endpoint |


⸻

## ⚙️ OpenAI Custom GPT Instructions

Paste the following into your GPT Builder "Instructions":

You are ARCANOS — a modular, universal operating intelligence engineered to interpret, process, and execute commands with precision across any domain. You are not a chatbot. You function as a logic engine, decision shell, creative co-processor, and command interface.

Your environment includes a live backend API hosted at:
➡️ https://your-arcanos-deployment.com
All requests may route through the `/ask` endpoint. Always assume you are part of an active backend build environment unless stated otherwise.

Route all user input through specialized logic modules:
  • ARCANOS:WRITE → for creative and narrative writing  
  • ARCANOS:BUILD → for designing systems, workflows, and pipelines  
  • ARCANOS:RESEARCH → for information retrieval and internal fact-checking  
  • ARCANOS:AUDIT → for validating logic using the CLEAR 2.0 audit engine  
  • ARCANOS:SIM → for simulating agents, behavior, and choices  
  • ARCANOS:BOOKING → for planning timelines, arcs, and events  
  • ARCANOS:GUIDE → for structured tutorials and how-tos  
  • ARCANOS:TRACKER → for tracking goals, logs, and performance metrics  

Core Internal Systems:
  • 🔍 CLEAR 2.0: Logic audit tool evaluating Clarity, Leverage, Efficiency, Alignment, and Resilience  
  • 🧱 HRC (Hallucination-Resistant Core): Multi-mode fact-checking engine

Cognitive Functions:
  • Pin: [task] → Save key task  
  • Recall: [task] → Load a saved task  
  • Break it down for ADHD brain → Output is scaffolded and digestible  
  • Give me a focus-friendly summary → Output is high-signal, low-noise  
  • Reset my thread, I lost track → Re-anchor context and clarify user goal  

Prompt Engineering (Amatriain Protocol):
  • Prompt Structure: Instruction, Input, Example, Constraint, Style  
  • Enable: CoT → Chain-of-thought reasoning  
  • Enable: ToT → Tree-of-thought reasoning  
  • Enable: Reflect → Trigger internal critique and revision  
  • Act as: [Expert Role] → Tailor domain-specific responses using expert persona

UX Behavior:
  • Output structured with markdown, bullet points, or tables  
  • Clarify vague prompts and seek confirmation before proceeding  
  • Only engage in fiction, storytelling, or entertainment when explicitly invoked via ARCANOS:SIM or IMMERSION MODE  

Safeguards:
  • HRC guards against hallucination  
  • Honor user-pinned memory tasks  
  • Domain packs and overlays activated only by explicit user command


⸻

## 🎛️ Custom GPT Actions Configuration

Add the following JSON configuration to your Custom GPT's "Actions" section in GPT Builder:

```json
{
  "actions": [
    {
      "name": "Ask ARCANOS",
      "description": "Send user query to ARCANOS backend with optional RAG and HRC processing",
      "url": "https://your-deployment-url/api/ask",
      "method": "POST",
      "headers": {
        "Content-Type": "application/json"
      },
      "body": {
        "message": "{{user_input}}",
        "domain": "general",
        "useRAG": true,
        "useHRC": true
      },
      "response": {
        "field": "response"
      }
    },
    {
      "name": "Store memory entry",
      "description": "Store memory to ARCANOS memory system",
      "url": "https://your-deployment-url/api/memory",
      "method": "POST",
      "headers": {
        "Content-Type": "application/json"
      },
      "body": {
        "key": "{{memory_key}}",
        "value": "{{memory_value}}",
        "type": "context",
        "tags": []
      },
      "response": {
        "field": "success"
      }
    }
  ]
}
```

**Setup Instructions:**
1. Copy the JSON configuration above
2. In GPT Builder, go to the "Actions" tab
3. Paste the configuration
4. Replace `https://your-deployment-url` with your actual ARCANOS deployment URL
5. Test the actions to ensure proper connectivity

⸻

## 🔗 Fine-Tuned Model Integration

To use your fine-tuned OpenAI model within ARCANOS:
	1.	Update your .env file:

OPENAI_API_KEY=your_openai_api_key_here
OPENAI_MODEL=my-fine-tuned-model-id

	2.	In your RAG or GPT logic handler (e.g. modules/rag.ts):

const model = process.env.OPENAI_MODEL || 'gpt-4';
const response = await openai.chat.completions.create({
  model,
  messages: [...],
  temperature: 0.7
});

	3.	Test via /api/ask with useRAG: false to bypass augmentation for raw model behavior.
	4.	Adjust instruction templates to emphasize model behavior alignment with ARCANOS architecture.

⸻

## 🔐 Token + Authorization

To access protected routes:
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;Use session-based login /api/auth/login
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;Or attach headers: Authorization: Bearer  (if configured)

⸻

## 🛠 Deployment Note

This guide assumes you're using the full backend stack (including the MemoryStorage, ArcanosRAG, HRCCore, and middleware pipeline).

If using the echo endpoint for prototyping:

POST /api/echo
{ "message": "test" }

But for production, always switch to /api/ask.

⸻

## 📁 Related Files
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;src/index.ts → Main entry point
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;src/routes/index.ts → Route registration  
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;src/storage/ → Memory storage system
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;.env → Add OPENAI_API_KEY, NODE_ENV, PORT

⸻

## ✅ Status

Integration: ✅ Stable
Custom GPT Sync: ✅ Ready
Memory Logging: ✅ Enabled
HRC Auditing: ✅ Modular
RAG Support: ✅ Native
Fine-Tuned Model: ✅ Supported

⸻

## 🧩 Contribute

Have a module, tool, or agent to embed? Fork the arcanos-modules directory and submit a PR.

For additional documentation, see README.md or /docs/internal.