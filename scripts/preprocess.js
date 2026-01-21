export async function initBridge() {
  if (process.env.BRIDGE_ENABLED !== "true") {
    console.log("[Bridge] Disabled via environment variable.");
    useLegacyFlow();
    return;
  }

  try {
    const { bridge } = await import("../daemon/bridge.js");
    if (bridge?.active) {
      console.log("[Bridge] Active - routing requests via daemon bridge.");
    } else {
      console.log("[Bridge] Inactive - falling back to legacy mode.");
      useLegacyFlow();
    }
  } catch (err) {
    console.log("[Bridge] Fallback triggered - bridge unavailable.");
    useLegacyFlow();
  }
}

function useLegacyFlow() {
  console.log("[Legacy] Operating without daemon bridge.");
}
