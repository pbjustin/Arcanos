import express from 'express';
import OpenAI from 'openai';
import pg from 'pg';

const router = express.Router();
const pool = new pg.Pool(); // uses DATABASE_URL from .env
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Save memory entry with type tagging
 */
router.post('/save', async (req, res) => {
  const { module, tag, content, type = 'user_content' } = req.body;
  try {
    const result = await pool.query(
      `INSERT INTO memory_logs (module, tag, content, type, timestamp)
       VALUES ($1, $2, $3, $4, NOW())
       RETURNING id, module, tag, type, timestamp`,
      [module, tag, JSON.stringify(content), type]
    );
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[ /memory/save ]', err);
    res.status(500).json({ error: 'Save failed', details: err.message });
  }
});

/**
 * Natural Language retrieval using ARCANOS v2 fine-tune
 */
router.post('/nl', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    // Step 1: NL → SQL WHERE clause (via ARCANOS v2 sub-agent)
    const aiResponse = await openai.chat.completions.create({
      model: 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH',
      messages: [
        { role: 'system', content: 'Convert natural language into SQL WHERE clauses for user_content in memory_logs table.' },
        { role: 'user', content: query }
      ],
      temperature: 0.2,
    });

    const whereClause = aiResponse.choices[0].message.content.trim();

    // Step 2: Run SQL only for user_content
    const sql = `
      SELECT id, module, tag, content, timestamp
      FROM memory_logs
      WHERE type='user_content' AND ${whereClause}
      ORDER BY timestamp DESC
      LIMIT 20;
    `;

    const result = await pool.query(sql);
    res.json({
      query,
      sql_where: whereClause,
      results: result.rows,
    });
  } catch (err) {
    console.error('[ /memory/nl ]', err);
    res.status(500).json({ error: 'Query failed', details: err.message });
  }
});

export default router;
