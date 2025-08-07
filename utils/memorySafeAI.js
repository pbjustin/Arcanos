// memorySafeAI.js
import OpenAI from "openai";
import cron from "node-cron";
import os from "os";

const openai = new OpenAI({ 
  apiKey: process.env.OPENAI_API_KEY || 'sk-placeholder-key-for-testing'
});
const HEAP_LIMIT_MB = 512;
const HEAP_THRESHOLD = HEAP_LIMIT_MB * 0.8 * 1024 * 1024;

let isThrottled = false;

// 🔁 Auto-trigger GC every 30s
cron.schedule("*/30 * * * * *", () => {
  if (global.gc) {
    global.gc();
    console.log("[GC] Manual GC triggered.");
  }
  const mem = process.memoryUsage();
  console.log(`[MEM] HeapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB | RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
});

// 🧠 AI Request Wrapper with Safety Checks
export async function safeChat(prompt) {
  const mem = process.memoryUsage();
  if (mem.heapUsed > HEAP_THRESHOLD) {
    console.warn("[THROTTLE] Memory high — skipping OpenAI call.");
    isThrottled = true;
    return { error: "Memory limit exceeded, try again later." };
  }

  // Check if we have a valid API key
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'sk-placeholder-key-for-testing') {
    console.warn("[API] OpenAI API key not configured, returning mock response.");
    return { error: "OpenAI API key not configured" };
  }

  try {
    const start = Date.now();
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [{ role: "user", content: prompt }],
    });
    const latency = Date.now() - start;
    console.log(`[OPENAI] Completed in ${latency}ms`);
    return response.choices[0].message.content;
  } catch (err) {
    console.error("[OPENAI ERROR]", err.message);
    return { error: err.message };
  }
}