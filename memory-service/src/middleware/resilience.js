const REQUEST_TIMEOUT_MS = 15000;

export default function resilience(req, res, next) {
  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(503).json({ error: "Request timeout" });
    }
  }, REQUEST_TIMEOUT_MS);

  res.on("finish", () => clearTimeout(timeout));
  res.on("close", () => clearTimeout(timeout));

  next();
}
