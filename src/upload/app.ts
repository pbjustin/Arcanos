import express from "express";
import uploadRoute from "./routes/upload.js";
import abstractRoute from "./routes/abstractUpload.js";
import analyzeRoute from "./routes/analyze.js";
import healthRoute from "./routes/health.js";
import { limiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { ensureDir } from "./utils/ensureDir.js";
import { config } from "./config/index.js";

/**
 * Purpose: Build and configure the upload-focused Express application.
 * Inputs/Outputs: No runtime inputs; returns a fully wired Express app instance.
 * Edge cases: Upload directory creation is awaited before route registration.
 */
export async function createApp() {
  await ensureDir(config.UPLOAD_ROOT);

  const app = express();

  app.use(limiter);
  app.use(express.json());

  app.use("/api/upload", uploadRoute);
  app.use("/api/abstract-upload", abstractRoute);
  app.use("/api/upload-and-analyze", analyzeRoute);
  app.use("/health", healthRoute);

  app.use(errorHandler);

  return app;
}
