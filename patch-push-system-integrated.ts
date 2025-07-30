// 📦 PATCH PUSH SYSTEM - GitHub + OpenAI SDK Compatible (Integrated Version)
// This version integrates with the existing AI patch system for better reliability

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import OpenAI from 'openai';
import { aiPatchSystem } from './src/services/ai-patch-system';

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

// 2. Commit + Push to Main Branch (Enhanced with integrated AI patch system)
async function commitAndPush(filePath: string, content: string, useIntegratedSystem = true) {
  if (useIntegratedSystem) {
    try {
      console.log("🔗 Using integrated AI patch system for better reliability...");
      
      const result = await aiPatchSystem.processPatch({
        content,
        filename: path.basename(filePath),
        taskDescription: 'AI-generated patch content via standalone script'
      });
      
      if (result.success) {
        console.log(`✅ Patch committed and pushed via integrated system. SHA: ${result.sha}`);
        return result;
      } else {
        console.log("⚠️ Integrated system failed, falling back to git commands...");
        throw new Error(result.error || 'Integrated system failed');
      }
    } catch (integratedError) {
      console.log("⚠️ Integrated system error, falling back to git commands...");
      console.error("Integrated error:", integratedError);
    }
  }
  
  // Fallback to original git commands
  try {
    execSync(`git add ${filePath}`);
    execSync(`git commit -m "🤖 AI Patch Update - ${path.basename(filePath)}"`);
    execSync(`git push origin main`);
    console.log("✅ Patch committed and pushed via git commands.");
  } catch (err) {
    console.error("❌ Git push failed:", err);
    
    // Ensure logs directory exists
    const logsDir = './logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    fs.appendFileSync('./logs/patch_failures.log', `${new Date().toISOString()} - ${err}\n`);
    throw err;
  }
}

// 3. ENTRY POINT
export async function runIntegratedPatchPushSystem() {
  try {
    console.log("🚀 Starting Integrated Patch Push System...");
    const { filePath, content } = await generatePatchContent("Write a patch update summarizing backend changes.");
    console.log(`📄 Generated content (${content.length} characters) saved to: ${filePath}`);
    
    const result = await commitAndPush(filePath, content, true);
    return { success: true, filePath, contentLength: content.length, result };
  } catch (error) {
    console.error("❌ Patch system failed:", error);
    
    // Ensure logs directory exists
    const logsDir = './logs';
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    
    fs.appendFileSync('./logs/patch_failures.log', `${new Date().toISOString()} - ${error}\n`);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// Original standalone version (as per problem statement)
(async () => {
  try {
    const { filePath, content } = await generatePatchContent("Write a patch update summarizing backend changes.");
    await commitAndPush(filePath, content, false); // Use git commands as in original
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