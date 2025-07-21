/*
  ARCANOS SEND SERVICE
  
  PURPOSE:
  Axios logic for hitting the fine-tune endpoint at:
  https://arcanos-production-426d.up.railway.app/query-finetune
*/

const axios = require('axios');

const FINETUNE_ENDPOINT = 'https://arcanos-production-426d.up.railway.app/query-finetune';

/**
 * Send query to the fine-tune endpoint
 * @param {string} query - The user query
 * @param {Object} metadata - Optional metadata (user info, session, etc.)
 * @returns {Promise<Object>} Response from fine-tune endpoint
 */
async function sendToFineTune(query, metadata = {}) {
  try {
    console.log('🚀 Sending query to fine-tune endpoint:', query.substring(0, 100) + '...');
    
    const payload = {
      query,
      metadata,
      timestamp: new Date().toISOString()
    };

    const response = await axios.post(FINETUNE_ENDPOINT, payload, {
      timeout: 30000, // 30 second timeout
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ARCANOS-Router/1.0'
      }
    });

    console.log('✅ Fine-tune endpoint responded successfully');
    return {
      success: true,
      data: response.data,
      status: response.status
    };

  } catch (error) {
    console.error('❌ Error calling fine-tune endpoint:', error.message);
    
    if (error.response) {
      // Server responded with error status
      return {
        success: false,
        error: `Fine-tune endpoint error: ${error.response.status}`,
        data: error.response.data,
        status: error.response.status
      };
    } else if (error.request) {
      // No response received
      return {
        success: false,
        error: 'Fine-tune endpoint unreachable',
        data: null,
        status: null
      };
    } else {
      // Request setup error
      return {
        success: false,
        error: `Request error: ${error.message}`,
        data: null,
        status: null
      };
    }
  }
}

module.exports = {
  sendToFineTune
};