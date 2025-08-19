import axios from "axios";

// Backend API endpoint (your ARCANOS backend)
const ARC_URL = "https://arcanos-v2-production.up.railway.app/ask";

// Hardcode routing: Force GPT-5 + ARCANOS only
async function forceArcanosRouting(prompt: string) {
  try {
    const response = await axios.post(ARC_URL, {
      prompt,
      // Force GPT-5 analysis with no fallback allowed
      routing: {
        allowFallback: false,
        forceModel: "gpt-5",
        modules: ["ARCANOS:BOOKING", "ARCANOS:WRITE", "ARCANOS:RESEARCH"]
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
