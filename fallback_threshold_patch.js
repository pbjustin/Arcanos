// fallback_threshold_patch.js
// Tightens fallback so GPT-5 is only bypassed if completely unreachable
// Adds confirmation log before model switch

import { getModelStatus, switchModel, logEvent } from './arc_core.js';

export default async function enforceFortressFallback() {
    logEvent('FORTRESS fallback enforcement initiated.');

    const gpt5Status = await getModelStatus('GPT-5');

    if (gpt5Status === 'unreachable') {
        logEvent('GPT-5 unreachable. Confirmation check passed.');
        await switchModel('FallbackModel');
        logEvent('Model switched to FallbackModel.');
    } else {
        logEvent('GPT-5 operational. No fallback engaged.');
    }
}

