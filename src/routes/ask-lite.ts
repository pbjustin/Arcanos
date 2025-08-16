// 🚀 Simulated AI Plugin Route in Railway Environment
// This will be called by ChatGPT plugin via POST /ask-lite
// Input: { prompt: string }
// Output: { result: string }
// Logs should appear in Railway logs dashboard
// Keep schema flat to avoid plugin schema rejection

import express from "express";
const router = express.Router();

// Simulate /ask-lite route
router.post("/ask-lite", (req, res) => {
  const { prompt } = req.body;

  console.log("🔁 [Railway] /ask-lite invoked");
  console.log("📥 Received prompt:", prompt);

  // Basic validation
  if (!prompt || typeof prompt !== "string") {
    console.error("❌ Invalid prompt payload");
    return res.status(400).json({ result: "Invalid prompt" });
  }

  // Simulated processing delay (optional)
  // setTimeout(() => {
  //   console.log("✅ Returning success response");
  //   res.json({ result: "✅ Lite AI ping successful." });
  // }, 500);

  // Instant return
  res.json({
    result: "✅ Lite AI ping successful."
  });
});

export default router;