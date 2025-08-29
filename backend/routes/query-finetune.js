import express from "express";
import OpenAI from "openai";

const router = express.Router();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Updated to arcanos-v2 model
const FINETUNE_MODEL = "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH";

router.post("/", async (req, res) => {
  try {
    const { prompt } = req.body;

    // Basic input validation
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return res.status(400).json({ error: "Prompt is required" });
    }

    const completion = await openai.chat.completions.create({
      model: FINETUNE_MODEL,
      messages: [
        { role: "system", content: "ARCANOS sub-agent (grunt work layer)" },
        { role: "user", content: prompt },
      ],
    });

    res.json({
      model: FINETUNE_MODEL,
      response: completion.choices[0].message,
    });
  } catch (error) {
    console.error("Finetune sub-agent failed for prompt:", req.body?.prompt, error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
