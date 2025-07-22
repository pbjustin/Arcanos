const express = require('express');
const router = express.Router();
const pool = require('../services/database-connection');
const memory = require('../memory/kernel');

// Middleware to parse JSON
router.use(express.json());

// POST /memory/save - Save memory key-value pair
router.post('/save', async (req, res) => {
  try {
    const { key, value } = req.body;
    
    if (!key) {
      return res.status(400).json({ 
        error: 'key is required',
        example: { key: 'user_preference', value: { theme: 'dark' } }
      });
    }

    if (value === undefined) {
      return res.status(400).json({ 
        error: 'value is required (can be null)',
        example: { key: 'user_preference', value: { theme: 'dark' } }
      });
    }

    const query = `
      INSERT INTO memory (key, value)
      VALUES ($1, $2)
      ON CONFLICT (key) 
      DO UPDATE SET 
        value = EXCLUDED.value
      RETURNING *
    `;
    
    const result = await pool.query(query, [key, JSON.stringify(value)]);
    
    res.status(200).json({
      success: true,
      message: 'Memory saved successfully',
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('❌ Error saving memory:', error);
    res.status(500).json({ 
      error: 'Failed to save memory',
      details: error.message 
    });
  }
});

// GET /memory/load - Load memory by key
router.get('/load', async (req, res) => {
  try {
    const key = req.query.key;
    
    if (!key) {
      return res.status(400).json({ 
        error: 'key parameter is required',
        example: '/memory/load?key=user_preference'
      });
    }

    const query = 'SELECT * FROM memory WHERE key = $1';
    const result = await pool.query(query, [key]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Memory not found',
        key: key
      });
    }
    
    res.status(200).json({
      success: true,
      message: 'Memory loaded successfully',
      data: result.rows[0]
    });
    
  } catch (error) {
    console.error('❌ Error loading memory:', error);
    res.status(500).json({ 
      error: 'Failed to load memory',
      details: error.message 
    });
  }
});

// GET /memory/all - Get all memory entries
router.get('/all', async (req, res) => {
  try {
    const query = 'SELECT * FROM memory ORDER BY key';
    const result = await pool.query(query);
    
    res.status(200).json({
      success: true,
      message: 'All memory loaded successfully',
      count: result.rows.length,
      data: result.rows
    });
    
  } catch (error) {
    console.error('❌ Error loading all memory:', error);
    res.status(500).json({ 
      error: 'Failed to load all memory',
      details: error.message 
    });
  }
});

// DELETE /memory/clear - Clear all memory
router.delete('/clear', async (req, res) => {
  try {
    const query = 'DELETE FROM memory';
    const result = await pool.query(query);
    
    res.status(200).json({
      success: true,
      message: 'Memory cleared successfully',
      cleared_count: result.rowCount
    });
    
  } catch (error) {
    console.error('❌ Error clearing memory:', error);
    res.status(500).json({ 
      error: 'Failed to clear memory',
      details: error.message 
    });
  }
});

// GET /memory/health - Health check for memory service
router.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    
    res.status(200).json({
      service: 'arcanos-memory',
      status: 'healthy',
      database: true,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Memory health check failed:', error);
    res.status(503).json({
      service: 'arcanos-memory',
      status: 'unhealthy',
      database: false,
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
});

// POST /memory/bootstrap - Initialize memory schema if missing
router.post('/bootstrap', async (req, res) => {
  const result = await memory.dispatch('bootstrap');
  if (result.error) {
    return res.status(500).json({ error: result.error });
  }
  res.json(result);
});

module.exports = router;