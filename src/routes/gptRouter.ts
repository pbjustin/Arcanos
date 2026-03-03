import express from "express";
import { routeGptRequest } from "./_core/gptDispatch.js";
import {
  logGptConnection,
  logGptConnectionFailed,
  logGptAckSent,
  type GptRoutingInfo,
} from "@platform/logging/gptLogger.js";

const router = express.Router();

router.post("/:gptId", async (req, res, next) => {
  try {
    const incomingGptId = req.params.gptId;

    const envelope = await routeGptRequest({
      gptId: incomingGptId,
      body: req.body,
      requestId: (req as any).requestId,
      logger: (req as any).logger,
    });

    if (!envelope.ok) {
      if (envelope.error.code === "UNKNOWN_GPT") {
        logGptConnectionFailed(incomingGptId);
        return res.status(404).json(envelope);
      }
      return res.status(400).json(envelope);
    }

    const routingInfo: GptRoutingInfo = {
      gptId: envelope._route.gptId,
      moduleName: envelope._route.module ?? "unknown",
      route: envelope._route.route ?? "unknown",
      matchMethod: (envelope._route.matchMethod as any) ?? "none",
    };

    logGptConnection(routingInfo);
    logGptAckSent(routingInfo, (envelope._route.availableActions ?? []).length);

    return res.json(envelope);
  } catch (err) {
    return next(err);
  }
});

export default router;
