import axios from 'axios';

/**
 * Core ask service for handling fallback queries
 */
export async function coreAsk(query: string, mode: string): Promise<string> {
  try {
    const response = await axios.post('https://arcanos-production-426d.up.railway.app/ask', {
      query, 
      mode
    });
    return response.data.response;
  } catch (error: any) {
    console.error('❌ Core ask service error:', error.message);
    throw new Error(`Core service unavailable: ${error.message}`);
  }
}