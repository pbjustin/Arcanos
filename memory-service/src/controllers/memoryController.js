import { memoryService } from "../services/memoryService.js";

export async function commitMemory(req, res) {
  try {
    const result = await memoryService.commit(req.body);
    res.status(200).json(result);
  } catch (err) {
    console.error("Memory commit failed", err);
    res.status(500).json({ error: "Commit failed" });
  }
}

export async function retrieveMemory(req, res) {
  try {
    const { traceId } = req.params;
    const result = await memoryService.retrieve(traceId);
    const status = result.error ? 404 : 200;
    res.status(status).json(result);
  } catch (err) {
    console.error("Memory retrieve failed", err);
    res.status(500).json({ error: "Retrieve failed" });
  }
}
