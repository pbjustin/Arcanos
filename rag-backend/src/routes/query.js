import express from "express";
import { pool } from "../db.js";
import OpenAI from "openai";

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const chatModel = process.env.OPENAI_MODEL;

router.post("/", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "`query` is required" });
    }

    const qEmbedding = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: query,
    });

    const result = await pool.query(
      `SELECT content FROM memory_chunks
       ORDER BY embedding <-> $1
       LIMIT 5`,
      [qEmbedding.data[0].embedding]
    );

    const context = result.rows.map((r) => r.content).join("\n");

    if (!chatModel) {
      return res.status(500).json({ error: "OPENAI_MODEL is not set" });
    }

    const completion = await openai.chat.completions.create({
      model: chatModel,
      messages: [
        { role: "system", content: "You are ARCANOS, answering with retrieved context." },
        { role: "user", content: `Answer based on:\n${context}\n\nUser query: ${query}` },
      ],
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Query failed" });
  }
});

export default router;
