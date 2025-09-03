import express from "express";
import { pool } from "../db.js";
import { openai } from "../openai.js";
import { CHAT_MODEL, EMBEDDING_MODEL, TOP_K, SYSTEM_PROMPT } from "../config.js";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) {
      return res.status(400).json({ error: "`query` is required" });
    }

    const qEmbedding = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    });

    const result = await pool.query(
      `SELECT content FROM memory_chunks
       ORDER BY embedding <-> $1
       LIMIT $2`,
      [qEmbedding.data[0].embedding, TOP_K]
    );

    const context = result.rows.map((r) => r.content).join("\n");

    if (!CHAT_MODEL) {
      return res.status(500).json({ error: "OPENAI_MODEL is not set" });
    }

    const completion = await openai.chat.completions.create({
      model: CHAT_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
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
