import { Router } from "express";
import { agents } from "../storage/inMemoryStore.js";

export const registerRouter = Router();

registerRouter.post("/", (req, res) => {
  const { agentId, version } = req.body;

  agents.set(agentId, {
    agentId,
    version,
    lastHeartbeat: new Date().toISOString(),
    state: "REGISTERED",
    health: 1.0
  });

  res.json({ status: "registered" });
});
