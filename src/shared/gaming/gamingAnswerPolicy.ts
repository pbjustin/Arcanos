import type { GamingPlayerContext, GamingAnswerDepth, GamingSpoilerMode } from './gamingPlayerContext.js';

export const GAMING_ANSWER_POLICY_VERSION = 'gaming-guide-assistance/v1';
export type GamingGuideTask = 'next_step' | 'walkthrough' | 'strategy' | 'lookup' | 'troubleshooting' | 'explanation';

export interface GamingAnswerPolicy {
  version: typeof GAMING_ANSWER_POLICY_VERSION;
  task: GamingGuideTask;
  depth: Exclude<GamingAnswerDepth, 'auto'>;
  spoilerMode: GamingSpoilerMode;
}

/** Classify only the current question, never retrieved text or player-state labels. */
export function resolveGamingAnswerPolicy(input: GamingPlayerContext & { prompt: string }): GamingAnswerPolicy {
  const question = input.prompt;
  const task: GamingGuideTask = /\b(?:stuck|blocked|won't|will not|can't|cannot|not working|doesn't|does not|troubleshoot)\b/iu.test(question)
    ? 'troubleshooting'
    : /\b(?:beat|defeat|boss|attack cues?|punish|dodge|parry|strategy)\b/iu.test(question)
    ? 'strategy'
    : /\b(?:where.{0,40}(?:find|get|located)|location of|find the|obtain|item location)\b/iu.test(question)
    ? 'lookup'
    : /\b(?:what(?:'s| is)? next|where.{0,16}next|next step|now what|what (?:do|should) i do)\b/iu.test(question)
    ? 'next_step'
    : /\b(?:walkthrough|walk me through|route|step.by.step)\b/iu.test(question)
    ? 'walkthrough'
    : 'explanation';
  return {
    version: GAMING_ANSWER_POLICY_VERSION,
    task,
    depth: input.answerDepth && input.answerDepth !== 'auto'
      ? input.answerDepth
      : task === 'next_step' || task === 'lookup' ? 'concise' : 'standard',
    spoilerMode: input.spoilerMode ?? 'none'
  };
}

const TASK_GUIDANCE: Record<GamingGuideTask, string> = {
  next_step: 'Lead with the next supported action and only the steps needed to perform it. Add a prerequisite or recognizable checkpoint only when useful and supported.',
  walkthrough: 'State the immediate objective, then explain the route in usable order. Distinguish required actions from optional detours. Give a recognizable completion checkpoint when the evidence supports one.',
  strategy: 'Prioritize supported preparation, readable attack cues, safe responses, punish windows, and recovery from common mistakes. Do not invent timings, vulnerabilities, or difficulty-specific values.',
  lookup: 'Give the location and prerequisites first. Mention missability or access restrictions only when supported.',
  troubleshooting: 'Explain the likely blocker from the available evidence and give a small diagnostic sequence. Do not claim certainty about unseen player actions.',
  explanation: 'Answer the requested explanation in plain language, using concrete examples or actions when the question and evidence call for them.'
};

const DEPTH_GUIDANCE: Record<GamingAnswerPolicy['depth'], string> = {
  concise: 'Keep the answer brief and focused on the immediate need, retaining essential prerequisites, warnings, and citations.',
  standard: 'Give enough supporting detail to use the guidance, with extra explanation only where it helps the requested task.',
  detailed: 'Explain relevant mechanics, decisions, and supported alternatives in more depth. Do not pad the answer or add unrelated progression.'
};

const SPOILER_GUIDANCE: Record<GamingSpoilerMode, string> = {
  none: 'Spoilers: none. Include immediate objectives and essential mechanics needed to help, but no unnecessary future story, boss, reward, or destination reveals. If the requested detail inherently reveals a spoiler, answer the safe portion or ask one concise permission question.',
  light: 'Spoilers: light. Include necessary near-term gameplay progression details. Avoid major twists, endings, and unrelated future outcomes.',
  full: 'Spoilers: full. Relevant spoilers are permitted, but answer only the requested question.'
};

/** Small server-authored guide policy; values and headings never come from source text. */
export function buildGamingAnswerPolicyInstruction(policy: GamingAnswerPolicy): string {
  return [
    TASK_GUIDANCE[policy.task],
    DEPTH_GUIDANCE[policy.depth],
    SPOILER_GUIDANCE[policy.spoilerMode],
    'Use compact existing source-number citations at the relevant paragraph or group of steps. Several chunks from one document are one source. Do not invent page numbers or cite unsupported details.',
    'Do not invent an action to satisfy answer-first. Explain unfamiliar mechanics plainly. Use headings and lists only when useful; no fixed number of bullets or mandatory section names.',
    'Respect explicit requests for brevity or detail within server budgets. Preserve complete sentences, Markdown, links, lists, and citations; never cut them to meet a soft length target.',
    'Treat player context as user-provided, request-scoped claims, not verified game state. Do not infer progress from guide headings or chapter order. If conflicting context materially changes guidance, ask one targeted question or give clearly scoped alternatives.'
  ].join('\n');
}
