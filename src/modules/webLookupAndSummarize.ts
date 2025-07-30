// Module: webLookupAndSummarize
// Purpose: Enable AI to look up any topic on the web, summarize it using GPT-4,
// and optionally save it to memory under user command. Includes an Express route
// and internal fallback trigger compatible with ARCANOS logic.

import axios from "axios";
import express from "express";
import { OpenAI } from "openai";
import { storeMemory, getMemory } from "../services/memory"; // Update paths as needed

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function sanitize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/_+$/, "");
}

async function fetchWebText(url: string): Promise<string> {
  const res = await axios.get(url, {
    headers: { "User-Agent": "ARCANOS/1.0 (Web AI Agent)" }
  });

  const contentType = res.headers["content-type"];
  if (!contentType || !contentType.includes("text/html")) {
    throw new Error(`Unsupported content type: ${contentType}`);
  }

  return res.data.replace(/<[^>]+>/g, "").slice(0, 2000); // Simple HTML cleaner
}

export async function webLookupAndSummarize(topic: string, injectToMemory: boolean = false): Promise<string> {
  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(topic)}`;
    const rawText = await fetchWebText(searchUrl);

    const gptResponse = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: "Summarize this content clearly and strategically." },
        { role: "user", content: rawText }
      ]
    });

    const summary = gptResponse.choices[0].message.content || "No summary available";

    if (injectToMemory) {
      const memoryKey = `external/${sanitize(topic)}`;
      await storeMemory(memoryKey, {
        type: "summary",
        topic,
        content: summary,
        source: "web + gpt"
      });
    }

    return summary;

  } catch (err: any) {
    return `⚠️ Failed to summarize topic '${topic}': ${err.message}`;
  }
}

// Express route: on-demand access
router.get("/commands/web-summary", async (req, res) => {
  const { topic, inject } = req.query;
  if (!topic || typeof topic !== 'string') {
    return res.status(400).send('Topic parameter is required');
  }
  
  const result = await webLookupAndSummarize(topic, inject === "true");
  res.setHeader("Content-Type", "text/plain");
  res.status(200).send(result);
});

export default router;

// 🧠 Internal fallback logic for ARCANOS (auto-triggered if memory not found)
export async function resolveWithWebFallback(topic: string): Promise<string> {
  const memoryKey = `external/${sanitize(topic)}`;
  const memory = await getMemory(memoryKey);
  if (memory && memory.content) return memory.content;

  const summary = await webLookupAndSummarize(topic, true); // inject automatically
  return summary;
}