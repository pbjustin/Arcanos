import { Router } from "express";
import { handleCatchError, sendSuccessResponse } from "../utils/response";

const router = Router();

// Basic OpenAI webhook handler - logs event and acknowledges receipt
router.post("/openai", async (req, res) => {
  try {
    const event = req.body;
    console.log("[OPENAI-WEBHOOK] Event received", event);

    sendSuccessResponse(res, "OpenAI webhook received", { event });
  } catch (error: any) {
    handleCatchError(res, error, "OpenAI webhook");
  }
});

export default router;
