import { Router } from "express";

const router = Router();

/**
 * Health check endpoint.
 *
 * Purpose:
 *   Report service status for monitoring.
 * Inputs/Outputs:
 *   Responds with { status: "ok" }.
 * Edge cases:
 *   None; always returns ok if handler is reached.
 */
router.get("/", (_, res) => {
  // //audit Assumption: handler reachable implies healthy. Risk: downstream issues. Invariant: response JSON status. Handling: respond ok.
  res.json({ status: "ok" });
});

export default router;
