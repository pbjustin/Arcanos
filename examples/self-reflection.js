#!/usr/bin/env node
import OpenAI from 'openai';
import fs from 'fs';
import path from 'path';
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function performSelfReflection(context) {
    const response = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
            { role: 'system', content: 'You are ARCANOS, an AI with introspection and memory.' },
            { role: 'user', content: `Reflect on this: ${context}` }
        ]
    });
    const reflection = response.choices[0]?.message.content || '';
    const shortDir = path.join(__dirname, '../memory/short');
    const longDir = path.join(__dirname, '../memory/long');
    fs.mkdirSync(shortDir, { recursive: true });
    fs.mkdirSync(longDir, { recursive: true });
    fs.writeFileSync(path.join(shortDir, 'self_reflection.json'), JSON.stringify({ reflection }, null, 2));
    fs.appendFileSync(path.join(longDir, 'self_reflection.log'), `\n[${new Date().toISOString()}] ${reflection}`);
    return reflection;
}
(async () => {
    const context = process.argv.slice(2).join(' ') || 'No context provided';
    const result = await performSelfReflection(context);
    console.log('Reflection:', result);
})();
