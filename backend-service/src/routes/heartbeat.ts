import { Router } from "express";
import { agents } from "../storage/inMemoryStore.js";
import { requireAgentApiKey } from "../middleware/auth.js";
import { validateHeartbeatPayload } from "../validation/requestValidators.js";

export const heartbeatRouter = Router();

heartbeatRouter.post("/", requireAgentApiKey, (req, res) => {
  const validation = validateHeartbeatPayload(req.body);
  //audit assumption: heartbeat state updates are only safe after schema validation.
  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error });
  }

  const { agentId, state, health } = validation.value;

  const agent = agents.get(agentId);
  //audit invariant: heartbeat updates are valid only for pre-registered agents.
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  agent.lastHeartbeat = new Date().toISOString();
  agent.state = state;
  agent.health = health;

  res.json({ status: "ok" });
});
