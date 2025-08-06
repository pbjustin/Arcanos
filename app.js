import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

// Init OpenAI SDK with fine-tuned model
const openai = new OpenAI({
  apiKey: process.env.API_KEY,
});

// POST /ask → Core Dispatcher
app.post("/ask", async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ error: "Missing prompt in request body" });
  }

  try {
    const response = await openai.chat.completions.create({
      model: process.env.AI_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    });

    const output = response.choices[0].message.content;

    return res.json({
      result: output,
      module: process.env.AI_MODEL,
      meta: {
        tokens: response.usage,
        id: response.id,
        created: response.created,
      },
    });
  } catch (err) {
    console.error("OpenAI Error:", err.message);
    return res.status(500).json({ error: "AI failure", details: err.message });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(port, () => {
  console.log(`ARCANOS core listening on port ${port}`);
});