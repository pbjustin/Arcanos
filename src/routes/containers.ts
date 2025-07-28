// 📦 ARCANOS CONTAINER MANAGER — UNIFIED BACKEND API BLOCK
// Enables monitoring + control for both backstage-booker and core-diagnostics containers

import { Router } from "express";
import { exec } from "child_process";

const router = Router();

// ✅ 1. STATUS: List tracked containers
router.get("/status", (_req, res) => {
  exec("docker ps --format '{{json .}}'", (err, stdout) => {
    if (err) return res.status(500).json({ error: "Docker status failed" });

    const containers = stdout
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((c) =>
        ["backstage-booker", "core-diagnostics"].includes(c.Names),
      );

    res.json(containers);
  });
});

// ✅ 2. CONTROL: Start, stop, restart containers by name
router.post("/:name/:action", (req, res) => {
  const { name, action } = req.params;
  const validActions = ["start", "stop", "restart"];

  if (!validActions.includes(action)) {
    return res.status(400).json({ error: "Invalid action" });
  }

  exec(`docker ${action} ${name}`, (err) => {
    if (err)
      return res.status(500).json({ error: `${action} failed on ${name}` });
    res.json({ message: `${name} ${action}ed successfully` });
  });
});

export default router;
