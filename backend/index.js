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

// Your NEW fine-tuned Arcanos model ID
const MODEL_ID = "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote";

// Route: Query the fine-tuned model
app.post("/arcanos", async (req, res) => {
  try {
    const { prompt } = req.body;

    const response = await openai.chat.completions.create({
      model: MODEL_ID,  // ✅ using your new fine-tuned model
      messages: [
        { role: "system", content: "You are ARCANOS, an advanced AI logic engine." },
        { role: "user", content: prompt }
      ],
    });

    res.json({
      reply: response.choices[0].message.content,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Arcanos backend running on port ${PORT}`);
});