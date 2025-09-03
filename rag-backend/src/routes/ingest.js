import express from "express";
import { pool } from "../db.js";
import { openai } from "../openai.js";
import { chunkText } from "../utils.js";
import { CHUNK_SIZE, EMBEDDING_MODEL } from "../config.js";
import { v4 as uuidv4 } from "uuid";

const router = express.Router();

router.post("/", async (req, res) => {
  try {
    const { text, source_type = "doc", source_tag = "general", metadata = {} } = req.body;
    if (!text) {
      return res.status(400).json({ error: "`text` is required" });
    }
    const chunks = chunkText(text, CHUNK_SIZE);

    await Promise.all(
      chunks.map(async (chunk) => {
        const embedding = await openai.embeddings.create({
          model: EMBEDDING_MODEL,
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
