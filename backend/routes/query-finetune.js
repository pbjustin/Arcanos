import express from "express";
import OpenAI from "openai";

const router = express.Router();
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 🔄 Swap v1 → v2 here
// Old: "ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106"
// New:
const FINETUNE_MODEL = "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH";

router.post("/", async (req, res) => {
  try {
    const { prompt } = req.body;

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
    console.error("Finetune sub-agent failed:", error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
