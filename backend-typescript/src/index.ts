import express from "express";
import askRoute from "./routes/ask";
import updateRoute from "./routes/update";
import healthRoute from "./routes/health";

/**
 * Create and configure the ARCANOS HTTP server.
 *
 * Purpose:
 *   Sets up middleware and routes for the backend.
 * Inputs/Outputs:
 *   No inputs; returns an Express application instance.
 * Edge cases:
 *   Throws if route registration fails.
 */
export const createServer = () => {
  const app = express();
  app.use(express.json());

  app.use("/ask", askRoute);
  app.use("/update", updateRoute);
  app.use("/health", healthRoute);

  return app;
};

const app = createServer();
const PORT = process.env.PORT || 3000;

// //audit Assumption: PORT is usable as a string/number. Risk: invalid port. Invariant: Express listens on provided port. Handling: rely on Express error propagation.
app.listen(PORT, () => console.log(`[ARCANOS] Server running on port ${PORT}`));
