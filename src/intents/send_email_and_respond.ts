import { Request, Response } from "express";
import { sendEmail } from "../services/email";
import { OpenAIService, ChatMessage } from "../services/openai";
import { aiConfig } from "../config";

let openaiService: OpenAIService | null = null;

function getOpenAIService(): OpenAIService {
  if (!openaiService) {
    openaiService = new OpenAIService({
      identityOverride: aiConfig.identityOverride,
      identityTriggerPhrase: aiConfig.identityTriggerPhrase,
    });
  }
  return openaiService;
}

export async function sendEmailAndRespond(req: Request, res: Response) {
  try {
    const { to, subject, body } = req.body;

    if (!to || !subject || !body) {
      return res
        .status(400)
        .json({ error: "Missing required fields: to, subject, body." });
    }

    // Convert text body to HTML for the new service
    const htmlBody = body.replace(/\n/g, "<br>");

    const emailResult = await sendEmail(to, subject, htmlBody);

    const messages: ChatMessage[] = [
      {
        role: "system",
        content: "You are ARCANOS, a modular AI operations interface.",
      },
      { role: "user", content: "Confirm diagnostics and report readiness." },
    ];
    const aiService = getOpenAIService();
    const aiResponse = await aiService.chat(messages);

    return res.status(200).json({
      success: true,
      email: emailResult,
      modelResponse: aiResponse.message,
      model: aiResponse.model,
    });
  } catch (error: any) {
    console.error("sendEmailAndRespond error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
