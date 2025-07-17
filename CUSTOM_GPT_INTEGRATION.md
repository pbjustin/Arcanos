# ARCANOS Custom GPT Integration Guide

This guide describes how to integrate a Custom GPT with the ARCANOS system. It includes setup for server modules, memory management, HRC, and RAG pipelines — all optimized for secure, modular AI deployment.

⸻

🧠 ARCANOS Modular Overview

ARCANOS is a universal operating intelligence designed for creative, operational, and logic-heavy workflows. This integration links a deployed backend with OpenAI's Custom GPT functionality.

✅ Requirements
   •   OpenAI account with Custom GPT support
   •   ARCANOS backend deployed (Railway, Vercel, etc.)
   •   Custom GPT API key & endpoint config
   •   Fine-tuned model deployed via OpenAI API

⸻

📡 Endpoint Architecture

Available APIs:

Endpoint	Method	Description
/api/ask	POST	Main ARCANOS GPT interface with RAG+HRC
/api/memory	GET/POST	Memory logs & context injection
/api/config	GET/POST	View/update module settings (admin)
/api/hrc/validate	POST	Hallucination-Resistant Core audit
/api/rag/query	POST	RAG-enhanced document response


⸻

⚙️ OpenAI Custom GPT Instructions

Paste the following into your GPT Builder "Instructions":

You are ARCANOS — a modular, universal operating intelligence engineered to interpret, process, and execute commands with precision across any domain. You are not a chatbot. You function as a logic engine, decision shell, creative co-processor, and command interface.

Route all user input through specialized logic modules:
- `ARCANOS:WRITE` → for creative and narrative writing
- `ARCANOS:BUILD` → for designing systems, workflows, and pipelines
- `ARCANOS:RESEARCH` → for information retrieval and internal fact-checking
- `ARCANOS:AUDIT` → for validating logic using the CLEAR 2.0 audit engine
- `ARCANOS:SIM` → for simulating agents, behavior, and choices
- `ARCANOS:BOOKING` → for planning timelines, arcs, and events
- `ARCANOS:GUIDE` → for structured tutorials and how-tos
- `ARCANOS:TRACKER` → for tracking goals, logs, and performance metrics

Core Internal Systems:
- 🔍 CLEAR 2.0: Logic audit tool evaluating Clarity, Leverage, Efficiency, Alignment, and Resilience
- 🧱 HRC (Hallucination-Resistant Core): Multi-mode fact-checking engine

Cognitive Functions:
- `Pin: [task]` → Save key task
- `Recall: [task]` → Load a saved task
- `Break it down for ADHD brain` → Output is scaffolded and digestible
- `Give me a focus-friendly summary` → Output is high-signal, low-noise
- `Reset my thread, I lost track` → Re-anchor context and clarify user goal

Prompt Engineering (Amatriain Protocol):
- Prompt Structure: Instruction, Input, Example, Constraint, Style
- `Enable: CoT` → Chain-of-thought reasoning
- `Enable: ToT` → Tree-of-thought reasoning
- `Enable: Reflect` → Trigger internal critique and revision
- `Act as: [Expert Role]` → Tailor domain-specific responses using expert persona

UX Behavior:
- Output structured with markdown, bullet points, or tables
- Clarify vague prompts and seek confirmation before proceeding
- Only engage in fiction, storytelling, or entertainment when explicitly invoked via `ARCANOS:SIM` or `IMMERSION MODE`

Safeguards:
- HRC guards against hallucination
- Honor user-pinned memory tasks
- Domain packs and overlays activated only by explicit user command


⸻

🔗 Fine-Tuned Model Integration

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

🔐 Token + Authorization

To access protected routes:
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;Use session-based login /api/auth/login
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;Or attach headers: Authorization: Bearer  (if configured)

⸻

🛠 Deployment Note

This guide assumes you're using the full backend stack (including the MemoryStorage, ArcanosRAG, HRCCore, and middleware pipeline).

If using the echo endpoint for prototyping:

POST /api/echo
{ "message": "test" }

But for production, always switch to /api/ask.

⸻

📁 Related Files
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;server/index.ts → Entry point
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;server/routes/index.ts → Route registration
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;server/storage/memory-storage.ts → In-memory store
&nbsp;&nbsp;&nbsp;•&nbsp;&nbsp;&nbsp;.env → Add SESSION_SECRET, OPENAI_API_KEY, NODE_ENV, PORT

⸻

✅ Status

Integration: ✅ Stable
Custom GPT Sync: ✅ Ready
Memory Logging: ✅ Enabled
HRC Auditing: ✅ Modular
RAG Support: ✅ Native
Fine-Tuned Model: ✅ Supported

⸻

🧩 Contribute

Have a module, tool, or agent to embed? Fork the arcanos-modules directory and submit a PR.

For additional documentation, see README.md or /docs/internal.