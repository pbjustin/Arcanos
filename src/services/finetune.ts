import axios from 'axios';

export async function sendToFinetune(query: string, mode: string): Promise<string> {
  try {
    console.log(`🔥 Finetune service: Sending query to finetune endpoint`);
    const response = await axios.post('https://arcanos-production-426d.up.railway.app/ask', {
      query, 
      mode
    });
    console.log(`✅ Finetune service: Response received`);
    return response.data.response;
  } catch (error: any) {
    console.error('❌ Finetune service error:', error.message);
    throw new Error(`Finetune service unavailable: ${error.message}`);
  }
}

export async function sendToCore(query: string, mode: string): Promise<string> {
  try {
    console.log(`🎯 Core service: Sending query to core endpoint`);
    const response = await axios.post('https://arcanos-production-426d.up.railway.app/ask', {
      query, 
      mode
    });
    console.log(`✅ Core service: Response received`);
    return response.data.response;
  } catch (error: any) {
    console.error('❌ Core service error:', error.message);
    throw new Error(`Core service unavailable: ${error.message}`);
  }
}