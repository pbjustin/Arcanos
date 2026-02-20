import { Router } from "express";
import { handleUpload } from "../services/uploadService.js";
import { analyzeExtractedFiles } from "../services/analyzeService.js";

const router = Router();

/**
 * POST /api/upload-and-analyze
 *
 * Accepts a zip file upload, extracts it, reads the text file contents,
 * sends them to the backend AI, and returns the AI's analysis.
 *
 * Query params:
 *   ?prompt=<custom instruction for the AI>
 *   ?assistant=<name of a custom GPT assistant to use>
 *   ?gptId=<GPT ID to route through the /gpt router>
 *
 * Priority: assistant > gptId > default (/ask Trinity pipeline)
 */
router.post("/", async (req, res, next) => {
  try {
    const { uploadId, extractedFiles } = await handleUpload(req);

    const userPrompt = typeof req.body.prompt === "string"
      ? req.body.prompt
      : undefined;

    const assistantName = typeof req.body.assistant === "string"
      ? req.body.assistant
      : undefined;

    const gptId = typeof req.body.gptId === "string"
      ? req.body.gptId
      : undefined;

    const analysis = await analyzeExtractedFiles(
      uploadId,
      extractedFiles,
      { userPrompt, assistantName, gptId }
    );

    res.json(analysis);
  } catch (err) {
    next(err);
  }
});

export default router;
