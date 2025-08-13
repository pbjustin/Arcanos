// File: arcanos-interface.js
// Requires: npm install openai

import OpenAI from "openai";

// Initialize the OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY, // Store API key in environment variables
  baseURL: "https://api.openai.com"   // Keep default unless using a proxy
});

/**
 * Sends a prompt to ARCANOS and returns the response.
 * @param {string} prompt - The user query or command.
 */
async function queryArcanos(prompt) {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4.1", // Change if ARCANOS uses a different model
      messages: [
        { role: "system", content: "You are ARCANOS, the operational AI." },
        { role: "user", content: prompt }
      ],
      max_tokens: 500
    });

    // Return AI's response text
    return completion.choices[0].message.content;
  } catch (error) {
    console.error("OpenAI API call failed:", error);
    return null;
  }
}

// Example usage
(async () => {
  const result = await queryArcanos("Run full diagnostics and return status report.");
  console.log("ARCANOS Response:", result);
})();

export { queryArcanos };
