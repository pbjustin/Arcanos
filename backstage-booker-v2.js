/**
 * BackstageBooker v2.0
 * --------------------
 * Adds automatic reflection to storylines when saving.
 */

import express from "express";
import { Pool } from "pg";
import OpenAI from "openai";

// -------------------
// Database Connection
// -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * SQL Schema Extension:
 * 
 * CREATE TABLE backstage_booker (
 *   id SERIAL PRIMARY KEY,
 *   timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
 *   key TEXT UNIQUE,
 *   storyline JSONB,
 *   reflection TEXT
 * );
 */

// -------------------
// Save / Load Functions
// -------------------
async function saveBackstageBooker(key, storyline, reflection = null) {
  const query = `
    INSERT INTO backstage_booker (key, storyline, reflection)
    VALUES ($1, $2, $3)
    ON CONFLICT (key) DO UPDATE
    SET storyline = EXCLUDED.storyline,
        reflection = EXCLUDED.reflection,
        timestamp = NOW()
    RETURNING *;
  `;
  const values = [key, JSON.stringify(storyline), reflection];
  const result = await pool.query(query, values);
  return result.rows[0];
}

async function loadBackstageBooker(key) {
  const query = `SELECT storyline, reflection FROM backstage_booker WHERE key = $1;`;
  const result = await pool.query(query, [key]);
  return result.rows.length > 0 ? result.rows[0] : null;
}

// -------------------
// OpenAI Client
// -------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Core booking flow: Ask ARCANOS + auto-reflect
async function backstageBookerFlow(prompt) {
  // Step 1: ARCANOS generates storyline
  const response = await client.chat.completions.create({
    model: "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH",
    messages: [
      { role: "system", content: "ARCANOS OS: BackstageBooker integration active." },
      { role: "user", content: prompt },
    ],
    max_tokens: 800,
  });
  const storyline = response.choices[0].message.content;

  // Step 2: Reflection — validate & improve storyline
  const reflectionResp = await client.chat.completions.create({
    model: "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH",
    messages: [
      { role: "system", content: "ARCANOS OS: Reflect on saved storyline. Validate consistency with past storylines and suggest improvements." },
      { role: "user", content: `Storyline: ${storyline}` },
    ],
    max_tokens: 400,
  });
  const reflection = reflectionResp.choices[0].message.content;

  // Step 3: Save both storyline + reflection into DB
  await saveBackstageBooker("latest_storyline", { content: storyline }, reflection);

  return { storyline, reflection };
}

// -------------------
// Express API
// -------------------
const app = express();
app.use(express.json());

// Save storyline with reflection
app.post("/book", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: "Missing prompt" });

  const result = await backstageBookerFlow(prompt);
  res.json({ success: true, ...result });
});

// Load storyline + reflection
app.get("/load/:key", async (req, res) => {
  const key = req.params.key;
  const data = await loadBackstageBooker(key);
  if (!data) return res.status(404).json({ error: "Not found" });
  res.json({ success: true, data });
});

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok", module: "BackstageBooker v2.0" });
});

// -------------------
// Start Server
// -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BackstageBooker v2.0 running on port ${PORT} with reflection enabled`);
});

export default app;
