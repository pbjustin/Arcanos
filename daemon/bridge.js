import { createServer } from "http";
import { resolve } from "path";
import { pathToFileURL } from "url";

const DEFAULT_PORT = 7777;
const bridgeEnabled = process.env.BRIDGE_ENABLED === "true";

export const bridge = {
  active: bridgeEnabled,
  assignTag: (reqId) => `GPT-${process.env.GPT_ID || "ARCANOS"}-${reqId}`,
  routeRequest: (payload) => sendToDaemon(payload),
};

export function startBridgeServer() {
  if (!bridgeEnabled) {
    console.log("[Bridge] Disabled via environment variable.");
    return null;
  }

  const port = resolveBridgePort();
  const server = createServer((req, res) => {
    if (req.url === "/bridge-status") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("active");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  server.listen(port, () => {
    console.log(`[Bridge] Daemon active on port ${port}`);
  });

  return server;
}

function resolveBridgePort() {
  const raw = Number.parseInt(process.env.BRIDGE_PORT || "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_PORT;
}

function sendToDaemon(payload) {
  console.log("[Bridge] Routed payload:", payload);
  // Example: send to backend or handle IPC logic here.
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  startBridgeServer();
}
