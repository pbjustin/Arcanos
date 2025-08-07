import type { NextApiRequest, NextApiResponse } from "next";
import { runDiagnostics } from "../../utils/diagnostics";
import { executeTask } from "../../utils/taskExecutor";
import { queryFinetune } from "../../utils/fineTune";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { prompt } = req.body || {};

  if (!prompt || typeof prompt !== "string") {
    return res.status(400).json({ error: "Missing prompt." });
  }

  const lowerPrompt = prompt.toLowerCase();

  // Run diagnostics
  if (lowerPrompt.includes("diagnostics")) {
    const diagnostics = await runDiagnostics();
    return res.status(200).json(diagnostics);
  }

  // Execute task
  if (lowerPrompt.includes("execute") || lowerPrompt.includes("track")) {
    const output = await executeTask(prompt);
    return res.status(200).json(output);
  }

  // Default to fine-tuned AI model
  const aiResponse = await queryFinetune(prompt);
  if ((aiResponse as any).error) {
    return res.status(500).json(aiResponse);
  }
  return res.status(200).json(aiResponse);
}
