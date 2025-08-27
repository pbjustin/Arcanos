import express from 'express';
import { OpenAI } from 'openai';
import pg from 'pg';

export const pool = new pg.Pool();
export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const router = express.Router();

router.post('/nl', async (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'Missing query' });

  try {
    const aiResponse = await openai.chat.completions.create({
      model: 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH',
      messages: [
        {
          role: 'system',
          content:
            'You are a memory query assistant. Convert natural language into parameterized SQL WHERE clauses for the memory_logs table. Return JSON: {"where":"...","params":[]}. Use numbered parameters like $1.',
        },
        {
          role: 'user',
          content: `Query: "${query}"
Return fields: id, module, tag, content, timestamp`,
        },
      ],
      temperature: 0.2,
    });

    const aiContent = aiResponse.choices?.[0]?.message?.content ?? '{}';
    let parsed;
    try {
      parsed = JSON.parse(aiContent);
    } catch (e) {
      console.error('[ /memory/nl ] invalid AI response', aiContent);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const { where, params } = parsed;
    if (typeof where !== 'string' || !Array.isArray(params)) {
      console.error('[ /memory/nl ] invalid AI output structure', parsed);
      return res.status(500).json({ error: 'Internal server error' });
    }

    const sql = `
      SELECT id, module, tag, content, timestamp
      FROM memory_logs
      WHERE ${where}
      ORDER BY timestamp DESC
      LIMIT 20
    `;

    const result = await pool.query(sql, params);

    res.json({
      query,
      sql_where: where,
      results: result.rows,
    });
  } catch (err) {
    console.error('[ /memory/nl ]', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
