/*
  ARCANOS QUERY ROUTER
  
  PURPOSE:
  Handles POST /query requests and applies fallback rejection logic.
  Routes all valid queries to the fine-tune endpoint.
*/

const express = require('express');
const { sendToFineTune } = require('../services/send');

const router = express.Router();

/**
 * Check if the query contains fallback indicators
 * @param {string} query - The user query
 * @returns {boolean} True if fallback is detected
 */
function detectFallback(query) {
  if (!query || typeof query !== 'string') {
    return false;
  }

  const fallbackPatterns = [
    /--fallback/i,
    /::default/i,
    /:default/i,
    /use\s+default/i,
    /fallback\s+model/i,
    /switch\s+to\s+default/i
  ];

  return fallbackPatterns.some(pattern => pattern.test(query));
}

/**
 * POST /query endpoint
 * Routes queries to fine-tune endpoint, rejects fallback attempts
 */
router.post('/query', async (req, res) => {
  try {
    const { query, metadata } = req.body;

    // Validate required fields
    if (!query) {
      return res.status(400).json({
        error: 'Query field is required',
        timestamp: new Date().toISOString()
      });
    }

    if (typeof query !== 'string') {
      return res.status(400).json({
        error: 'Query must be a string',
        timestamp: new Date().toISOString()
      });
    }

    // Check for fallback attempts
    if (detectFallback(query)) {
      console.log('❌ Fallback attempt detected and rejected:', query.substring(0, 100) + '...');
      return res.status(403).json({
        error: 'Fallback behavior is not allowed. This router only supports fine-tuned model queries.',
        rejected_patterns: ['--fallback', '::default', 'use default', 'fallback model'],
        timestamp: new Date().toISOString()
      });
    }

    console.log('🎯 Processing valid query for fine-tune model');

    // Send to fine-tune endpoint
    const result = await sendToFineTune(query, metadata);

    if (result.success) {
      res.json({
        success: true,
        response: result.data,
        model: 'gpt-3.5-turbo-0125:personal:arcanos-v1-1106',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(502).json({
        error: 'Fine-tune endpoint error',
        details: result.error,
        timestamp: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('❌ Query router error:', error);
    res.status(500).json({
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;