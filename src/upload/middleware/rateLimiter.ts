import rateLimit from "express-rate-limit";
import { config } from "../config/index.js";

/**
 * Purpose: Apply request throttling to upload endpoints.
 * Inputs/Outputs: Uses configured window + max values and returns Express middleware.
 * Edge cases: Shared proxies should set trust proxy upstream for correct client IP resolution.
 */
export const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX
});
