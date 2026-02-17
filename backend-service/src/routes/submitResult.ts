import { Router } from "express";
import { requireAgentApiKey } from "../middleware/auth.js";
import { assignedTasks, taskResults } from "../storage/inMemoryStore.js";
import { validateSubmitResultPayload } from "../validation/requestValidators.js";

export const submitResultRouter = Router();

submitResultRouter.post("/", requireAgentApiKey, (req, res) => {
  const validation = validateSubmitResultPayload(req.body);
  //audit assumption: result persistence requires validated task and agent identifiers.
  if (!validation.isValid) {
    return res.status(400).json({ error: validation.error });
  }

  const { agentId, taskId, result } = validation.value;
  const assignment = assignedTasks.get(taskId);

  //audit strategy: reject results for unknown/unassigned tasks to prevent data injection.
  if (!assignment) {
    return res.status(404).json({ error: "Task assignment not found" });
  }

  //audit invariant: only the assigned agent may submit the task result.
  if (assignment.agentId !== agentId) {
    return res.status(403).json({ error: "Task does not belong to this agent" });
  }

  assignedTasks.delete(taskId);
  taskResults.push({
    taskId,
    agentId,
    result,
    submittedAt: new Date().toISOString()
  });

  //audit data-handling: log metadata only to avoid leaking sensitive task payloads/results.
  console.info("Task result recorded", { taskId, agentId });
  res.json({ acknowledged: true });
});
