import crypto from "crypto";

declare module "express-serve-static-core" {
  interface Request {
    requestId?: string;
  }
}

export function requestId(req: any, _res: any, next: any) {
  if (typeof req.requestId === "string" && req.requestId.trim().length > 0) {
    next();
    return;
  }

  const incoming = req.headers?.["x-request-id"];
  req.requestId = typeof incoming === "string" && incoming.trim().length > 0 ? incoming : crypto.randomUUID();
  next();
}
