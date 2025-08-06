import express from "express";
import { OpenAI } from "openai";
import cron from "node-cron";
import dotenv from "dotenv";
import os from "os";

dotenv.config();

if (typeof global.gc !== "function") {
  console.warn("🚫 GC not exposed. Start with --expose-gc");
  process.exit(1);
}

console.log(`✅ Detected ${os.cpus().length} CPU cores`);

setInterval(() => {
  const m = process.memoryUsage();
  console.log(
    `[MEMORY] Heap: ${(m.heapUsed / 1024 / 1024).toFixed(2)} MB / ${(m.heapTotal / 1024 / 1024).toFixed(2)} MB | RSS: ${(m.rss / 1024 / 1024).toFixed(2)} MB`
  );
}, 30000);

setInterval(() => {
  const m = process.memoryUsage();
  if (m.heapUsed / m.heapTotal > 0.8) {
    console.log("[GC] Triggered at 80% heap usage");
    global.gc();
  }
}, 45000);

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`[SERVER] Running on 0.0.0.0:${PORT}`)
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.post("/chat", async (req, res) => {
  const before = process.memoryUsage().heapUsed / 1e6;
  try {
    const { message } = req.body;
    const resp = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: message }],
    });
    const after = process.memoryUsage().heapUsed / 1e6;
    console.log(`[CHAT] Memory delta: ${(before - after).toFixed(1)} MB`);
    return res.json({ text: resp.choices[0].message.content });
  } catch (err) {
    console.error("[CHAT ERR]", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.send("OK"));
