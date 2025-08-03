import express from "express";
import { OpenAI } from "openai";
import cron from "node-cron";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`[SERVER] Running on 0.0.0.0:${PORT}`)
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ========== PATCH: Memory Diagnostics & GC ==========

// 🧠 Enable manual GC if started with --enable-gc
const enableGC = process.argv.includes('--enable-gc');

if (enableGC && typeof global.gc === 'function') {
  setInterval(() => {
    global.gc();
    console.log('🧹 Manual GC triggered');
  }, 10000); // Every 10s
}

// 💾 Heap usage monitor
const reportMemory = () => {
  const mem = process.memoryUsage();
  const heapUsedMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const heapTotalMB = (mem.heapTotal / 1024 / 1024).toFixed(2);
  const rssMB = (mem.rss / 1024 / 1024).toFixed(2);
  console.log(`📊 Memory [RSS: ${rssMB} MB] [Heap Used: ${heapUsedMB} MB / Total: ${heapTotalMB} MB]`);
};

setInterval(reportMemory, 10000); // Log every 10s

// 🚨 Auto-GC trigger if heap used > 80% of heapTotal
setInterval(() => {
  const mem = process.memoryUsage();
  const heapUsageRatio = mem.heapUsed / mem.heapTotal;
  if (heapUsageRatio > 0.8 && enableGC && typeof global.gc === 'function') {
    console.warn(`⚠️ High heap usage (${(heapUsageRatio * 100).toFixed(1)}%) - Triggering GC`);
    global.gc();
  }
}, 15000);

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
