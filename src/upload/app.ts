import express from "express";
import uploadRoute from "./routes/upload.js";
import abstractRoute from "./routes/abstractUpload.js";
import healthRoute from "./routes/health.js";
import { limiter } from "./middleware/rateLimiter.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { ensureDir } from "./utils/ensureDir.js";
import { config } from "./config/index.js";

ensureDir(config.UPLOAD_ROOT);

export const app = express();

app.use(limiter);
app.use(express.json());

app.use("/api/upload", uploadRoute);
app.use("/api/abstract-upload", abstractRoute);
app.use("/health", healthRoute);

app.use(errorHandler);
