import axios from 'axios';

export async function sendToFinetune(query: string, mode: string): Promise<string> {
  const response = await axios.post('https://arcanos-production-426d.up.railway.app/ask', {
    query, 
    mode
  });
  return response.data.response;
}

export async function sendToCore(query: string, mode: string): Promise<string> {
  const response = await axios.post('https://arcanos-production-426d.up.railway.app/ask', {
    query, 
    mode
  });
  return response.data.response;
}