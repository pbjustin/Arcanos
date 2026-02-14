import rateLimit from "express-rate-limit";
import { config } from "../config/index.js";

export const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX
});
