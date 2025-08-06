import express from 'express';
import OpenAI from 'openai';
const router = express.Router();
// Initialize OpenAI with validation
let openai = null;
try {
    const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
    if (apiKey) {
        openai = new OpenAI({ apiKey });
    }
    else {
        console.warn('⚠️  No OpenAI API key found. AI endpoints will return errors.');
    }
}
catch (error) {
    console.error('❌ Failed to initialize OpenAI client:', error);
}
router.post('/ask', async (req, res) => {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid prompt in request body' });
    }
    // Check if OpenAI client is available
    if (!openai) {
        return res.status(503).json({
            error: 'AI service unavailable',
            details: 'OpenAI client not initialized. Please check API key configuration.'
        });
    }
    try {
        const response = await openai.chat.completions.create({
            model: process.env.AI_MODEL || 'gpt-3.5-turbo',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            max_tokens: 1000,
        });
        const output = response.choices[0]?.message?.content;
        if (!output) {
            return res.status(500).json({
                error: 'No response from AI model',
                details: 'Empty response received from OpenAI'
            });
        }
        return res.json({
            result: output,
            module: process.env.AI_MODEL || 'gpt-3.5-turbo',
            meta: {
                tokens: response.usage || undefined,
                id: response.id,
                created: response.created,
            },
        });
    }
    catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('OpenAI Error:', errorMessage);
        // Handle specific OpenAI errors
        if (err instanceof OpenAI.APIError) {
            return res.status(err.status || 500).json({
                error: 'OpenAI API error',
                details: err.message
            });
        }
        return res.status(500).json({
            error: 'AI service failure',
            details: errorMessage
        });
    }
});
export default router;
