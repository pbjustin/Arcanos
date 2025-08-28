import express from "express";
import { findOrRegisterIdentity } from "../models/Identity.js";
import OpenAI from "openai";

const router = express.Router();
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

router.post("/ask", async (req, res) => {
  const { gptId, gptVersion, prompt, context } = req.body;

  if (!gptId || !prompt) {
    return res.status(400).json({ error: "gptId and prompt are required" });
  }

  try {
    const identity = await findOrRegisterIdentity(gptId, gptVersion);

    const completion = await client.chat.completions.create({
      model: "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote",
      messages: [
        { role: "system", content: "ARCANOS dispatcher active" },
        { role: "user", content: prompt },
      ],
    });

    res.json({
      result: completion.choices[0].message.content,
      module: "ARCANOS pipeline",
      meta: {
        gptId: identity.gpt_id,
        version: identity.gpt_version,
        calls: identity.call_count,
        lastSeen: identity.last_seen,
      },
    });
  } catch (err) {
    console.error("Error in /ask:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
