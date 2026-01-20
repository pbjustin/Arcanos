import { Router } from "express";
import memory from "../memory";

const router = Router();

/**
 * Resolve a value from memory by key.
 *
 * Purpose:
 *   Lookup stored values for clients.
 * Inputs/Outputs:
 *   Expects JSON body with key; responds with { key, value }.
 * Edge cases:
 *   If key is missing, returns undefined value.
 */
router.post("/", (req, res) => {
  const { key } = req.body;
  // //audit Assumption: key is present. Risk: undefined lookup. Invariant: memory.get handles missing keys. Handling: return undefined value.
  const value = memory.get(key);
  res.json({ key, value });
});

export default router;
