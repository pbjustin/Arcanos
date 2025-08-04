/**
 * Demonstrates routing prompts through the deepresearch flow.
 * In real usage set OPENAI_API_KEY in your environment.
 */
import { handleOpenAIRequest } from '../src/utils/openaiRequestHandler';
async function demoDeepResearch() {
    process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test_key_for_demo';
    const gameGuide = await handleOpenAIRequest({
        query: 'Give me a step-by-step strategy for beating the final boss in Elden Ring.',
        mode: 'deepresearch',
    });
    console.log('🎮 Game guide analysis:\n', gameGuide.choices?.[0]?.message?.content || gameGuide);
    const technical = await handleOpenAIRequest({
        query: 'Model the future of ARM-based servers over the next five years.',
        mode: 'deepresearch',
        context: { state: 'ARM adoption was limited outside mobile devices in 2020.' }
    });
    console.log('\n🛠️ Technical analysis:\n', technical.choices?.[0]?.message?.content || technical);
}
if (require.main === module) {
    demoDeepResearch().catch(err => {
        console.error('Deepresearch demo failed:', err);
        process.exit(1);
    });
}
export { demoDeepResearch };
