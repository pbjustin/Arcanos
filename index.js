import express from "express";
import { OpenAI } from "openai";
import cron from "node-cron";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
  console.log(`[SERVER] Running on 0.0.0.0:${PORT}`)
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const HEAP_LIMIT_BYTES = 6 * 1024 ** 3; // 6 GB
const THRESHOLD = HEAP_LIMIT_BYTES * 0.8;

cron.schedule("*/60 * * * * *", () => {
  const m = process.memoryUsage();
  console.log(`[MEM] HeapUsed=${(m.heapUsed/1e6).toFixed(1)} MB | RSS=${(m.rss/1e6).toFixed(1)} MB`);
  if (global.gc && m.heapUsed > THRESHOLD) {
    console.log("[MEM] ‣ High memory—triggering GC");
    global.gc();
  }
});

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
