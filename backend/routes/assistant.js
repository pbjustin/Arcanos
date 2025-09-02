import express from "express";
import OpenAI from "openai";

const router = express.Router();

// Initialize OpenAI client using the standard API key
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Optional default Assistant ID from environment
const DEFAULT_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;

/**
 * Run an OpenAI Assistant and return the final response.
 *
 * Request body:
 * {
 *   "prompt": "user message",
 *   "assistantId": "asst_123" // optional; falls back to OPENAI_ASSISTANT_ID
 * }
 */
router.post("/run", async (req, res) => {
  const { prompt, assistantId } = req.body || {};
  const asstId = assistantId || DEFAULT_ASSISTANT_ID;

  if (!prompt) {
    return res.status(400).json({ error: "Prompt is required" });
  }
  if (!asstId) {
    return res.status(400).json({ error: "Assistant ID is required" });
  }

  try {
    // 1. Create a fresh thread for this request
    const thread = await client.beta.threads.create();

    // 2. Add the user's message
    await client.beta.threads.messages.create(thread.id, {
      role: "user",
      content: prompt
    });

    // 3. Run the assistant on the thread
    const run = await client.beta.threads.runs.create(thread.id, {
      assistant_id: asstId
    });

    // 4. Poll until the run completes
    let runStatus;
    do {
      runStatus = await client.beta.threads.runs.retrieve(thread.id, run.id);
      if (runStatus.status === "completed") break;
      if (["failed", "cancelled", "expired"].includes(runStatus.status)) {
        throw new Error(runStatus.last_error?.message || `Run ${runStatus.status}`);
      }
      // wait for a second before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (true);

    // 5. Retrieve all messages and pick the assistant's reply
    const messages = await client.beta.threads.messages.list(thread.id);
    const assistantMessage = messages.data.find((m) => m.role === "assistant");
    const reply = assistantMessage?.content
      ?.map((c) => (c.text ? c.text.value : ""))
      .join("\n") || "";

    res.json({ reply, threadId: thread.id, runId: run.id });
  } catch (error) {
    console.error("Assistant route error:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;

