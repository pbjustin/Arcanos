/**
 * ARCANOS Backend - Reflection Enabled
 * ------------------------------------
 * This patch runs ARCANOS in reflection mode:
 * 1. Generates a response to the user's prompt.
 * 2. Runs a second validation call (memory kernel reflection).
 * 3. Returns both the main response and the reflection in JSON.
 */

import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Function to ask ARCANOS and reflect
 */
async function askArcanosWithReflection(prompt) {
  try {
    // Step 1: Get ARCANOS response
    const response = await client.chat.completions.create({
      model: "REDACTED_FINE_TUNED_MODEL_ID",
      messages: [
        {
          role: "system",
          content: "ARCANOS OS: Respond as normal. Audit-Safe Shim Active.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.7,
      max_tokens: 1200,
    });

    const mainResponse = response.choices[0].message.content;

    // Step 2: Run validation/reflection on the output
    const reflection = await client.chat.completions.create({
      model: "REDACTED_FINE_TUNED_MODEL_ID",
      messages: [
        {
          role: "system",
          content:
            "ARCANOS OS: Perform memory kernel validation and reflection. Check integrity, consistency, and correctness of the last response.",
        },
        {
          role: "user",
          content: `Validate and reflect on this response: "${mainResponse}"`,
        },
      ],
      temperature: 0.3,
      max_tokens: 600,
    });

    const reflectionReport = reflection.choices[0].message.content;

    return {
      success: true,
      response: mainResponse,
      reflection: reflectionReport,
    };
  } catch (error) {
    console.error("ARCANOS error:", error);
    return { success: false, error: error.message };
  }
}

/**
 * POST /ask endpoint with reflection
 */
app.post("/ask", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const result = await askArcanosWithReflection(prompt);
  res.json(result);
});

/**
 * Healthcheck
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok", reflection: true });
});

// 🚀 Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ARCANOS backend running on port ${PORT} with reflection`);
});
