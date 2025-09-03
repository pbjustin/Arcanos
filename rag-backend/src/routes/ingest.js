import express from "express";
import { pool } from "../db.js";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function chunkText(text, size = 800) {
  const words = text.split(" ");
  const chunks = [];
  for (let i = 0; i < words.length; i += size) {
    chunks.push(words.slice(i, i + size).join(" "));
  }
  return chunks;
}

router.post("/", async (req, res) => {
  try {
    const { text, source_type = "doc", source_tag = "general", metadata = {} } = req.body;
    if (!text) {
      return res.status(400).json({ error: "`text` is required" });
    }
    const chunks = chunkText(text);

    await Promise.all(
      chunks.map(async (chunk) => {
        const embedding = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: chunk,
        });

        await pool.query(
          `INSERT INTO memory_chunks (chunk_id, source_type, source_tag, metadata, embedding, content, token_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uuidv4(),
            source_type,
            source_tag,
            metadata,
            embedding.data[0].embedding,
            chunk,
            embedding.usage?.total_tokens ?? 0,
          ]
        );
      })
    );

    res.json({ message: "✅ Data ingested successfully", chunks: chunks.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Ingestion failed" });
  }
});

export default router;
