import { CorsOptions } from "cors";

const ALLOWED_ORIGINS_ENV = "ALLOWED_ORIGINS";

function parseAllowedOrigins(rawOrigins: string | undefined): Set<string> {
  if (!rawOrigins) {
    return new Set<string>();
  }

  return new Set(
    rawOrigins
      .split(",")
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0)
  );
}

/**
 * Builds restrictive CORS options for the backend service.
 * Input: process environment variables.
 * Output: CORS configuration object for Express middleware.
 * Edge case behavior: when ALLOWED_ORIGINS is empty, only same-origin/non-browser calls are allowed.
 */
export function createCorsOptions(): CorsOptions {
  const allowedOrigins = parseAllowedOrigins(process.env[ALLOWED_ORIGINS_ENV]);

  return {
    origin: (origin, callback) => {
      //audit assumption: requests without Origin are server-to-server/non-browser traffic and should remain allowed.
      if (!origin) {
        callback(null, true);
        return;
      }

      //audit strategy: enforce strict allowlist to prevent cross-origin access from untrusted sites.
      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["POST", "OPTIONS"],
    credentials: false
  };
}
