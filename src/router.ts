// router.ts - Simplified routing without hardcoded model IDs
import { getOpenAIClient, getDefaultModel, getGPT5Model } from './services/openai.js';

interface RouteRequestParams {
    source: string;
    payload: {
        messages: Array<{
            role: 'system' | 'user' | 'assistant';
            content: string;
        }>;
    };
}

interface RouteResponse {
    model: string;
    content: string;
}

const ALLOWED_SOURCES = new Set(['audit', 'logic', 'validation', 'schema']);

function validatePayload(payload: RouteRequestParams['payload']): void {
    if (!payload || !Array.isArray(payload.messages)) {
        throw new Error('Invalid payload: messages array required');
    }
    for (const msg of payload.messages) {
        if (!['system', 'user', 'assistant'].includes(msg.role) || typeof msg.content !== 'string') {
            throw new Error('Invalid message format');
        }
    }
}

async function safeCreate(params: any) {
    const client = getOpenAIClient();
    if (!client) {
        throw new Error('OpenAI client not initialized');
    }
    
    try {
        return await client.chat.completions.create(params);
    } catch (err) {
        throw new Error(`OpenAI request failed: ${err instanceof Error ? err.message : err}`);
    }
}

export async function routeRequest({ source, payload }: RouteRequestParams): Promise<RouteResponse> {
    const client = getOpenAIClient();
    if (!client) {
        throw new Error('OpenAI client not initialized. Please check API key configuration.');
    }

    if (!ALLOWED_SOURCES.has(source)) {
        throw new Error(`Unsupported source: ${source}`);
    }

    validatePayload(payload);

    // Simplified routing - use default model for all requests
    const modelName = getDefaultModel();
    const response = await safeCreate({
        model: modelName,
        messages: payload.messages,
    });

    return {
        model: modelName,
        content: response.choices[0].message.content || 'No content received'
    };
}