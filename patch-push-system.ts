// 📦 PATCH PUSH SYSTEM - GitHub + OpenAI SDK Compatible

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// 1. Generate content (or receive it via input function)
async function generatePatchContent(prompt: string, filename = 'ai_patch.md') {
  const completion = await openai.chat.completions.create({
    model: "gpt-4",
    messages: [
      { role: "system", content: "You are an AI engineer pushing backend patch notes." },
      { role: "user", content: prompt }
    ],
  });

  const content = completion.choices[0].message.content;
  if (!content) {
    throw new Error('No content generated from OpenAI');
  }
  
  const filePath = path.join(process.cwd(), filename);
  fs.writeFileSync(filePath, content, 'utf8');

  return { filePath, content };
}

// 2. Commit + Push to Main Branch
function commitAndPush(filePath: string) {
  try {
    execSync(`git add ${filePath}`);
    execSync(`git commit -m "🤖 AI Patch Update - ${path.basename(filePath)}"`);
    execSync(`git push origin main`);
    console.log("✅ Patch committed and pushed.");
  } catch (err) {
    console.error("❌ Git push failed:", err);
    
    // Ensure logs directory exists
    const logsDir = './logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    fs.appendFileSync('./logs/patch_failures.log', `${new Date().toISOString()} - ${err}\n`);
  }
}

// 3. ENTRY POINT
(async () => {
  try {
    const { filePath } = await generatePatchContent("Write a patch update summarizing backend changes.");
    commitAndPush(filePath);
  } catch (error) {
    console.error("❌ Patch system failed:", error);
    
    // Ensure logs directory exists
    const logsDir = './logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    fs.appendFileSync('./logs/patch_failures.log', `${new Date().toISOString()} - ${error}\n`);
  }
})();