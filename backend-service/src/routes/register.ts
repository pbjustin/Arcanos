import { Router } from "express";
import { agents } from "../storage/inMemoryStore.js";
import { requireAgentApiKey } from "../middleware/auth.js";
import { validateRegisterPayload } from "../validation/requestValidators.js";

export const registerRouter = Router();

registerRouter.post("/", requireAgentApiKey, (req, res) => {
  const validation = validateRegisterPayload(req.body);
  //audit assumption: body validation must run before mutating shared agent state.
  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error });
  }

  const { agentId, version } = validation.value;
  const now = new Date().toISOString();

  agents.set(agentId, {
    agentId,
    version,
    lastHeartbeat: now,
    state: "REGISTERED",
    health: 1.0
  });

  res.json({ status: "registered", registeredAt: now });
});
