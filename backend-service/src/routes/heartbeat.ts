import { Router } from "express";
import { agents } from "../storage/inMemoryStore.js";

export const heartbeatRouter = Router();

heartbeatRouter.post("/", (req, res) => {
  const { agentId, state, health } = req.body;

  const agent = agents.get(agentId);
  if (!agent) return res.status(404).json({ error: "Agent not found" });

  agent.lastHeartbeat = new Date().toISOString();
  agent.state = state;
  agent.health = health;

  res.json({ status: "ok" });
});
