import { createServer } from "http";
import { resolve } from "path";
import { pathToFileURL } from "url";

const DEFAULT_BRIDGE_PORT = 7777;
const DEFAULT_TAG_PREFIX = "GPT";
const DEFAULT_TAG_ID = "ARCANOS";
const BRIDGE_STATUS_PATH = "/bridge-status";
const BRIDGE_STATUS_RESPONSE = "active";
const BRIDGE_NOT_FOUND_RESPONSE = "not found";
const bridgeEnabled = process.env.BRIDGE_ENABLED === "true";

function resolveTagPrefix() {
  //audit Assumption: BRIDGE_TAG_PREFIX is a non-empty string; risk: empty prefix breaks routing tags; invariant: prefix defaults when invalid; handling: trim and fallback.
  const envValue = process.env.BRIDGE_TAG_PREFIX;
  const trimmed = typeof envValue === "string" ? envValue.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_TAG_PREFIX;
}

function resolveTagId() {
  //audit Assumption: GPT_ID is a non-empty identifier; risk: missing ID obscures audit trails; invariant: default ID used when empty; handling: trim and fallback.
  const envValue = process.env.GPT_ID;
  const trimmed = typeof envValue === "string" ? envValue.trim() : "";
  return trimmed.length > 0 ? trimmed : DEFAULT_TAG_ID;
}

function buildBridgeTag(reqId) {
  //audit Assumption: reqId is defined; risk: undefined values create malformed tags; invariant: tag contains reqId; handling: stringify fallback.
  const prefix = resolveTagPrefix();
  const tagId = resolveTagId();
  return `${prefix}-${tagId}-${String(reqId)}`;
}

export const bridge = {
  active: bridgeEnabled,
  assignTag: (reqId) => buildBridgeTag(reqId),
  routeRequest: (payload) => sendToDaemon(payload),
};

/**
 * Starts the bridge server when enabled.
 * Inputs: none (uses env configuration).
 * Outputs: http.Server instance or null when disabled.
 * Edge cases: returns null if BRIDGE_ENABLED is not "true".
 */
export function startBridgeServer() {
  //audit Assumption: bridgeEnabled gates server start; risk: unexpected start in managed runtimes; invariant: only start when enabled; handling: return null.
  if (!bridgeEnabled) {
    console.log("[Bridge] Disabled via environment variable.");
    return null;
  }

  const port = resolveBridgePort();
  const server = createServer((req, res) => {
    //audit Assumption: health check path is fixed; risk: misrouted probes; invariant: exact match; handling: return active status.
    if (req.url === BRIDGE_STATUS_PATH) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(BRIDGE_STATUS_RESPONSE);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end(BRIDGE_NOT_FOUND_RESPONSE);
  });

  server.listen(port, () => {
    console.log(`[Bridge] Daemon active on port ${port}`);
  });

  return server;
}

function resolveBridgePort() {
  //audit Assumption: BRIDGE_PORT is parseable; risk: invalid port prevents startup; invariant: port is finite and > 0; handling: fallback default.
  const raw = Number.parseInt(process.env.BRIDGE_PORT || "", 10);
  //audit Assumption: raw port within valid range; risk: binding failure; invariant: only accept positive ints; handling: default port.
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_BRIDGE_PORT;
}

function sendToDaemon(payload) {
  //audit Assumption: payload safe to log; risk: sensitive data exposure; invariant: payload is sanitized upstream; handling: log for debug only.
  console.log("[Bridge] Routed payload:", payload);
  // Example: send to backend or handle IPC logic here.
}

const isDirectRun =
  process.argv[1] &&
  //audit Assumption: process argv points to entrypoint; risk: false positives in loaders; invariant: URL equality indicates direct run; handling: start server only on match.
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

//audit Assumption: direct run implies manual execution; risk: side effects in import; invariant: only start on direct execution; handling: conditional start.
if (isDirectRun) {
  startBridgeServer();
}
