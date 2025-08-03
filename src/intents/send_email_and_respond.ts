import { Request, Response } from 'express';
import { sendEmail } from '../services/email.js';
import { getUnifiedOpenAI, type ChatMessage } from '../services/unified-openai.js';
import { aiConfig } from '../config/index.js';

let unifiedOpenAI: ReturnType<typeof getUnifiedOpenAI> | null = null;

function getUnifiedOpenAIService(): ReturnType<typeof getUnifiedOpenAI> {
  if (!unifiedOpenAI) {
    unifiedOpenAI = getUnifiedOpenAI({
      model: aiConfig.fineTunedModel,
    });
  }
  return unifiedOpenAI;
}

export async function sendEmailAndRespond(req: Request, res: Response) {
  try {
    const { to, subject, body } = req.body;

    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'Missing required fields: to, subject, body.' });
    }

    // Convert text body to HTML for the new service
    const htmlBody = body.replace(/\n/g, '<br>');
    
    const emailResult = await sendEmail(to, subject, htmlBody);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'You are ARCANOS, a modular AI operations interface.' },
      { role: 'user', content: 'Confirm diagnostics and report readiness.' }
    ];
    const aiService = getUnifiedOpenAIService();
    const aiResponse = await aiService.chat(messages);

    if (!aiResponse.success) {
      throw new Error(aiResponse.error || 'AI response failed');
    }

    return res.status(200).json({
      success: true,
      email: emailResult,
      modelResponse: aiResponse.content,
      model: aiResponse.model,
    });
  } catch (error: any) {
    console.error('sendEmailAndRespond error:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
