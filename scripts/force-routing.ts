import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const DEFAULT_ROUTING_URL = "https://arcanos-v2-production.up.railway.app/ask";
const DEFAULT_ROUTING_MODEL = "gpt-5";
const DEFAULT_ROUTING_MODULES = [
  "ARCANOS:BOOKING",
  "ARCANOS:WRITE",
  "ARCANOS:RESEARCH"
];

const routingUrl = process.env.ARCANOS_ROUTING_URL || DEFAULT_ROUTING_URL;
const routingModel = process.env.ARCANOS_ROUTING_MODEL || DEFAULT_ROUTING_MODEL;
const routingModules = (process.env.ARCANOS_ROUTING_MODULES || DEFAULT_ROUTING_MODULES.join(","))
  .split(",")
  .map(moduleName => moduleName.trim())
  .filter(Boolean);

// Hardcode routing: Force GPT-5.1 + ARCANOS only
async function forceArcanosRouting(prompt: string) {
  try {
    const response = await axios.post(routingUrl, {
      prompt,
      // Force GPT-5.1 analysis with no fallback allowed
      routing: {
        allowFallback: false,
        forceModel: routingModel,
        modules: routingModules
      }
    });

    return response.data;
  } catch (err: any) {
    console.error("ARCANOS routing error:", err.message);
    throw err;
  }
}

// Example usage
(async () => {
  const result = await forceArcanosRouting("Check if Backstage Booker is installed.");
  console.log("ARCANOS Response:", result);
})();
