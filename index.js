// index.js – Main entry for memory-optimized Node.js AI app

const { OpenAI } = require("openai");
const os = require("os");

// Manually trigger garbage collection every 5 mins if memory usage exceeds 75%
function setupMemoryGuardian() {
  if (global.gc) {
    setInterval(() => {
      const mem = process.memoryUsage();
      const ratio = mem.heapUsed / mem.heapTotal;
      if (ratio > 0.75) {
        console.log(`[MEMORY] High usage detected: ${Math.round(ratio * 100)}%. Running GC.`);
        global.gc();
      }
    }, 300000); // 5 min
  } else {
    console.warn("[WARN] GC not exposed. Start with: node --expose-gc index.js");
  }
}

setupMemoryGuardian();

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

async function run() {
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Summarize today’s tech news." }
    ],
  });

  console.log("[OPENAI RESPONSE]:", completion.choices[0].message.content);
}

run().catch(err => {
  console.error("[ERROR]", err);
  process.exit(1);
});
