// router.ts
import { openai } from './clients/openai.js'; // Assumes SDK client is modularized

// Model aliases for clarity
export const MODELS = {
    LIVE_GPT_4_1: "ft:gpt-4.1-2025-04-14:personal:arcanos:C8Msdote", // ✅ Your 4.1 fine-tune
    GPT_5: "gpt-5-arcarnos-preview",
    ARCANOS_V2: "ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH" // ✅ Your 3.5 fine-tune
};

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
    try {
        return await openai!.chat.completions.create(params);
    } catch (err) {
        throw new Error(`OpenAI request failed: ${err instanceof Error ? err.message : err}`);
    }
}

export async function routeRequest({ source, payload }: RouteRequestParams): Promise<RouteResponse> {
    let intermediate: any, finalOutput: any;

    // Check if OpenAI client is available
    if (!openai) {
        throw new Error('OpenAI client not initialized. Please check API key configuration.');
    }

    if (!ALLOWED_SOURCES.has(source)) {
        throw new Error(`Unsupported source: ${source}`);
    }

    validatePayload(payload);

    switch (source) {
        case "audit":
        case "logic":
            // Step 1: GPT-5 handles reasoning
            intermediate = await safeCreate({
                model: MODELS.GPT_5,
                messages: payload.messages,
            });

            // Step 2: Always reroute through GPT-4.1
            finalOutput = await safeCreate({
                model: MODELS.LIVE_GPT_4_1,
                messages: [
                    { role: "system", content: "Format and validate GPT-5 output for end user." },
                    { role: "user", content: intermediate.choices[0].message.content }
                ],
            });
            break;

        case "validation":
        case "schema":
            // Step 1: GPT-3.5 fine-tune handles structure
            intermediate = await safeCreate({
                model: MODELS.ARCANOS_V2,
                messages: payload.messages,
            });

            // Step 2: Always loop back through GPT-4.1
            finalOutput = await safeCreate({
                model: MODELS.LIVE_GPT_4_1,
                messages: [
                    { role: "system", content: "Refine validation output for user delivery." },
                    { role: "user", content: intermediate.choices[0].message.content }
                ],
            });
            break;

        default:
            // This should never occur due to ALLOWED_SOURCES check
            finalOutput = await safeCreate({
                model: MODELS.LIVE_GPT_4_1,
                messages: payload.messages,
            });
    }

    return {
        model: MODELS.LIVE_GPT_4_1,
        content: finalOutput.choices[0].message.content
    };
}