// 📚 CLEAN CANON ACCESS API — MERGE-SAFE VERSION
// Module: Backstage Booker / Canon Layer
// Enables: List, Read, Write access to canon storyline files

import { Router, Request, Response } from "express";
import * as fs from "fs";
import * as path from "path";
import { logEndpointCall } from "../services/endpoint-logger";

// Use project-relative path since /containers is not accessible
const CANON_PATH = path.join(__dirname, "../../storage/canon");
const router = Router();

// Ensure canon directory exists
if (!fs.existsSync(CANON_PATH)) {
  fs.mkdirSync(CANON_PATH, { recursive: true });
}

// List all canon files
router.get("/files", (req: Request, res: Response) => {
  logEndpointCall("/api/canon/files", req);
  fs.readdir(CANON_PATH, (err, files) => {
    if (err) {
      console.error("Error listing canon files:", err);
      return res.status(500).json({ error: "Unable to list canon files" });
    }
    res.json({ files });
  });
});

// Read a specific canon file
router.get("/files/:filename", (req: Request, res: Response) => {
  logEndpointCall(`/api/canon/files/${req.params.filename}`, req);
  const filename = req.params.filename;

  // Basic security check to prevent directory traversal
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.join(CANON_PATH, filename);
  fs.readFile(filePath, "utf-8", (err, data) => {
    if (err) {
      console.error("Error reading canon file:", err);
      return res.status(404).json({ error: "Canon file not found" });
    }
    res.json({ filename, content: data });
  });
});

// Write (or overwrite) a canon file
router.post("/files/:filename", (req: Request, res: Response) => {
  logEndpointCall(`/api/canon/files/${req.params.filename}`, req);
  const filename = req.params.filename;
  const content = req.body.content || "";

  // Basic security check to prevent directory traversal
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  const filePath = path.join(CANON_PATH, filename);
  fs.writeFile(filePath, content, "utf-8", (err) => {
    if (err) {
      console.error("Error writing canon file:", err);
      return res.status(500).json({ error: "Failed to write canon file" });
    }
    res.json({ message: "Canon file saved successfully" });
  });
});

export default router;
