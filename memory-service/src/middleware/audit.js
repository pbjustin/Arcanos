import { auditService } from "../services/auditService.js";

export default function audit(req, res, next) {
  const start = Date.now();

  res.on("finish", () => {
    auditService.record({
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - start
    });
  });

  next();
}
