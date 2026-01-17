import { Router } from "express";
import memory from "../memory.js";

const router = Router();

/**
 * Update a value in memory by key.
 *
 * Purpose:
 *   Store provided values for later retrieval.
 * Inputs/Outputs:
 *   Expects JSON body with key/value; responds with status.
 * Edge cases:
 *   If key is missing, stores under undefined key.
 */
router.post("/", (req, res) => {
  const { key, value } = req.body;
  // //audit Assumption: key/value provided. Risk: undefined key. Invariant: memory.set accepts any key. Handling: write as provided.
  memory.set(key, value);
  res.json({ status: "success", key, value });
});

export default router;
