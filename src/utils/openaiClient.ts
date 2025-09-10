// DEPRECATED: Use ../services/openai.ts instead for centralized OpenAI management
// This file is kept for backward compatibility only
import { getOpenAIClient } from '../services/openai.js';

export const openai = getOpenAIClient();
export default openai;
