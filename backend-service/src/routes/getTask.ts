import { Router } from "express";
import { requireAgentApiKey } from "../middleware/auth.js";
import { agents, assignedTasks, tasks } from "../storage/inMemoryStore.js";
import { validateGetTaskPayload } from "../validation/requestValidators.js";

export const getTaskRouter = Router();

getTaskRouter.post("/", requireAgentApiKey, (req, res) => {
  const validation = validateGetTaskPayload(req.body);
  //audit assumption: task dequeue operations require a validated agent identity.
  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error });
  }

  const { agentId } = validation.value;

  //audit strategy: deny task retrieval for unknown agents to prevent IDOR-style queue theft.
  if (!agents.has(agentId)) {
    return res.status(404).json({ error: "Agent not found" });
  }

  if (tasks.length === 0) {
    return res.json({ task: null });
  }

  const task = tasks.shift();
  //audit assumption: shift() can return undefined under race conditions; fail closed for consistency.
  if (!task) {
    return res.json({ task: null });
  }

  assignedTasks.set(task.taskId, {
    task,
    agentId,
    assignedAt: new Date().toISOString()
  });

  res.json({ task });
});
