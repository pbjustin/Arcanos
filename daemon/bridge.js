import { createServer } from "http";
import { resolve } from "path";
import { pathToFileURL } from "url";

const DEFAULT_PORT = 7777;
const bridgeEnabled = process.env.BRIDGE_ENABLED === "true";
const automationHeaderName = (process.env.ARCANOS_AUTOMATION_HEADER || 'x-arcanos-automation').toLowerCase();
const automationSecret = (process.env.ARCANOS_AUTOMATION_SECRET || '').trim();

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
  const server = createServer(async (req, res) => {
    const authorized = await isRequestAuthorized(req);
    if (!authorized) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("forbidden");
      return;
    }

    if (req.url === "/bridge-status") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("active");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  // //audit Assumption: bridge HTTP server should be local-only in dev; risk: exposure if bound to 0.0.0.0; invariant: bind to 127.0.0.1; handling: explicit host binding.
  server.listen(port, '127.0.0.1', () => {
    console.log(`[Bridge] Daemon active on port ${port} (bound to 127.0.0.1)`);
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

async function isRequestAuthorized(req) {
  const providedAutomation = req.headers[automationHeaderName];
  const automationHeaderValue = Array.isArray(providedAutomation) ? providedAutomation[0] : providedAutomation;
  if (automationSecret && automationHeaderValue === automationSecret) {
    return true;
  }

  const tokenHeader = req.headers['x-arcanos-confirm-token'];
  const tokenValue = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  if (!tokenValue) {
    return false;
  }

  // //audit Assumption: one-time token grants authorization; risk: replay if not consumed; invariant: token must be consumed by backend; handling: call consume endpoint and allow only on success.
  return await consumeConfirmToken(tokenValue);
}

async function consumeConfirmToken(token) {
  const backendUrlRaw = process.env.BACKEND_URL || process.env.SERVER_URL;
  if (!backendUrlRaw) {
    return false;
  }

  const backendUrl = backendUrlRaw.replace(/\/$/, '');
  const url = `${backendUrl}/debug/consume-confirm-token`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ token })
    });
    if (!response.ok) {
      return false;
    }
    const payload = await response.json();
    return Boolean(payload?.ok);
  } catch (err) {
    console.warn('[Bridge] Token validation failed');
    return false;
  }
}

const isDirectRun =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  startBridgeServer();
}
