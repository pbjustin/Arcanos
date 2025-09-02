import express from 'express';
import db from '../db.js';

const router = express.Router();

// Save a message to the chat log
router.post('/log', async (req, res) => {
  const { conversation_id, sender_id, message_text } = req.body;
  if (!conversation_id || !sender_id || !message_text) {
    return res.status(400).json({ error: 'conversation_id, sender_id, and message_text are required' });
  }

  try {
    await db.query(
      `INSERT INTO chat_messages (conversation_id, sender_id, message_text)
       VALUES ($1, $2, $3)`,
      [conversation_id, sender_id, message_text]
    );
    res.status(201).json({ status: 'stored' });
  } catch (err) {
    console.error('[ /chat/log ]', err);
    res.status(500).json({ error: 'Message store failed', details: err.message });
  }
});

// Retrieve messages for a conversation
router.get('/log/:conversationId', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT id, conversation_id, sender_id, message_text, created_at
       FROM chat_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [req.params.conversationId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ /chat/log/:conversationId ]', err);
    res.status(500).json({ error: 'Fetch failed', details: err.message });
  }
});

export default router;
