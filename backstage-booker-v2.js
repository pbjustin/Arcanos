/**
 * BackstageBooker v2.1
 * --------------------
 * Storyline saves now use both a timestamp and a UUID for guaranteed uniqueness.
 * Works with reflection workflow and prevents overwrite issues on rapid saves.
 */

import express from "express";
import { Pool } from "pg";
import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

// -------------------
// Database Connection
// -------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

/**
 * SQL Schema Update:
 *
 * CREATE TABLE backstage_booker (
 *   id UUID PRIMARY KEY,
 *   timestamp TIMESTAMP NOT NULL DEFAULT NOW(),
 *   key TEXT,
 *   storyline JSONB,
 *   reflection TEXT
 * );
 */

// -------------------
// Save / Load Functions
// -------------------
async function saveBackstageBooker(key, storyline, reflection = null) {
  const id = uuidv4();
  const query = `
    INSERT INTO backstage_booker (id, key, storyline, reflection)
    VALUES ($1, $2, $3, $4)
    RETURNING *;
  `;
  const values = [id, key, JSON.stringify(storyline), reflection];
  try {
    const result = await pool.query(query, values);
    return result.rows[0];
  } catch (err) {
    console.error("Error saving BackstageBooker entry", err);
    throw err;
  }
}

async function loadBackstageBooker(key) {
  const query = `SELECT id, timestamp, storyline, reflection FROM backstage_booker WHERE key = $1 ORDER BY timestamp DESC LIMIT 1;`;
  try {
    const result = await pool.query(query, [key]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    // Ensure storyline is returned as an object
    if (row.storyline && typeof row.storyline === "string") {
      row.storyline = JSON.parse(row.storyline);
    }
    return row;
  } catch (err) {
    console.error("Error loading BackstageBooker entry", err);
    throw err;
  }
}

// -------------------
// OpenAI Client
// -------------------
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function backstageBookerFlow(prompt) {
  try {
    // Step 1: Generate storyline
    const response = await client.chat.completions.create({
      model: "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH",
      messages: [
        { role: "system", content: "ARCANOS OS: BackstageBooker v2.1 with UUID+timestamp patch active." },
        { role: "user", content: prompt },
      ],
      max_tokens: 800,
    });
    const storyline = response.choices[0]?.message?.content?.trim();
    if (!storyline) throw new Error("Storyline generation failed");

    // Step 2: Reflect on storyline
    const reflectionResp = await client.chat.completions.create({
      model: "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH",
      messages: [
        { role: "system", content: "ARCANOS OS: Reflect on storyline. Validate against continuity and suggest improvements." },
        { role: "user", content: `Storyline: ${storyline}` },
      ],
      max_tokens: 400,
    });
    const reflection = reflectionResp.choices[0]?.message?.content?.trim();

    // Step 3: Save storyline + reflection with unique UUID + timestamp
    const saved = await saveBackstageBooker("latest_storyline", { content: storyline }, reflection);

    return { saved };
  } catch (err) {
    console.error("BackstageBooker flow failed", err);
    throw err;
  }
}

// -------------------
// Express API
// -------------------
const app = express();
app.use(express.json());

// Save storyline w/ reflection
app.post("/book", async (req, res) => {
  const { prompt } = req.body;
  if (typeof prompt !== "string" || prompt.trim() === "") {
    return res.status(400).json({ error: "Invalid prompt" });
  }
  try {
    const result = await backstageBookerFlow(prompt);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: "Failed to process request" });
  }
});

// Load latest storyline by key
app.get("/load/:key", async (req, res) => {
  const { key } = req.params;
  if (typeof key !== "string" || key.trim() === "") {
    return res.status(400).json({ error: "Invalid key" });
  }
  try {
    const data = await loadBackstageBooker(key);
    if (!data) return res.status(404).json({ error: "Not found" });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: "Failed to load data" });
  }
});

// Healthcheck
app.get("/health", (req, res) => {
  res.json({ status: "ok", module: "BackstageBooker v2.1" });
});

// -------------------
// Start Server
// -------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BackstageBooker v2.1 running with UUID+timestamp patch on port ${PORT}`);
});

export default app;

