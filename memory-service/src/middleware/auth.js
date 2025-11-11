import { config } from "../config/env.js";

export default function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!config.authToken || token !== config.authToken) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return next();
}
