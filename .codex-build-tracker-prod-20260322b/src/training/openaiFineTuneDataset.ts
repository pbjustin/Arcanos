import { createHash } from 'crypto';

export type FineTuneRole = 'user' | 'assistant';

export interface ChatExportConversation {
  id?: string | null;
  title?: string | null;
  current_node?: string | null;
  default_model_slug?: string | null;
  mapping?: Record<string, ChatExportNode | undefined> | null;
}

export interface ChatExportNode {
  id?: string | null;
  parent?: string | null;
  children?: string[] | null;
  message?: ChatExportMessage | null;
}

export interface ChatExportMessage {
  id?: string | null;
  author?: {
    role?: string | null;
    name?: string | null;
  } | null;
  content?: ChatExportContent | null;
  recipient?: string | null;
  status?: string | null;
  create_time?: number | null;
  update_time?: number | null;
}

export interface ChatExportContent {
  content_type?: string | null;
  parts?: unknown[] | null;
  text?: string | null;
  content?: string | null;
  user_instructions?: string | null;
}

export interface OpenAIFineTuneMessage {
  role: FineTuneRole;
  content: string;
}

export interface FineTuneDatasetExample {
  messages: OpenAIFineTuneMessage[];
  sourceConversationId: string;
  sourceConversationTitle: string;
  targetMessageId: string;
  sourceModelSlug: string | null;
}

export interface FineTuneDatasetIndexRecord {
  lineNumber: number;
  sourceConversationId: string;
  sourceConversationTitle: string;
  targetMessageId: string;
  messageCount: number;
  sourceModelSlug: string | null;
}

export interface FineTuneDatasetBuildOptions {
  validationRatio?: number;
  splitSeed?: string;
  maxMessagesPerExample?: number;
  minimumAssistantCharacters?: number;
}

export interface FineTuneDatasetBuildSummary {
  conversationsProcessed: number;
  conversationsWithExamples: number;
  conversationsSkipped: number;
  examplesBuilt: number;
  trainExamples: number;
  validationExamples: number;
  averageMessagesPerExample: number;
  skippedConversationReasons: Record<string, number>;
  sourceModelCounts: Record<string, number>;
}

export interface FineTuneDatasetBuildResult {
  allExamples: FineTuneDatasetExample[];
  trainExamples: FineTuneDatasetExample[];
  validationExamples: FineTuneDatasetExample[];
  summary: FineTuneDatasetBuildSummary;
}

interface NormalizedConversationMessage {
  role: FineTuneRole;
  content: string;
  messageId: string;
}

const DEFAULT_VALIDATION_RATIO = 0.1;
const DEFAULT_SPLIT_SEED = 'arcanos-openai-finetune';
const DEFAULT_MAX_MESSAGES_PER_EXAMPLE = 12;
const DEFAULT_MINIMUM_ASSISTANT_CHARACTERS = 8;

const HUMAN_CONTENT_MARKERS = [
  '### 🧠 Answer',
  '### Answer',
  '### 📖 Narrative Output',
  '### Narrative Output',
  '**Response:**',
  '**Answer:**'
];

const SYSTEM_TAIL_MARKERS = [
  '### 🛡️ Audit Summary',
  '### 🛑 Audit Summary',
  '### Audit Summary',
  '🛡️ Audit Summary',
  '🛑 Audit Summary',
  '📊 COMPLIANCE STATUS',
  '🎯 STRUCTURED RECOMMENDATIONS',
  'System Routing Details'
];

const STRUCTURAL_LINE_PATTERNS: RegExp[] = [
  /^[═─━\-]{3,}\s*$/,
  /^---\s*$/,
  /^#{1,3}\s*[🧠📋🔍📊🎯🛡️⚡✅❌🔒]/,
  /^[🧠📋🔍📊🎯🛡️⚡✅❌🔒]\s+[A-Z]/,
  /^>\s*".*🧠/
];

const SYSTEM_LINE_PATTERNS: RegExp[] = [
  /transaction type/i,
  /included modules/i,
  /active session id/i,
  /clearance level/i,
  /initiated by.*(?:frontend cli|backend|daemon)/i,
  /session_boot/i,
  /logic_engine/i,
  /goals_processor/i,
  /audit_trace/i,
  /boot_snapshot/i,
  /memory_shell_\d/i,
  /audit.?safe/i,
  /kernel rule set/i,
  /resilience patch/i,
  /fallback handler/i,
  /rollback handler/i,
  /logic dispatch/i,
  /goal articulation/i,
  /routing stages/i,
  /source verification/i,
  /reasoning path/i,
  /compliance status/i,
  /security measures applied/i,
  /all systems\s*✅/i,
  /auditable final response/i,
  /audit summary/i,
  /memory update/i,
  /linked memory/i,
  /\bHRC\b.*(?:STRICT|LENIENT|SILENTFAIL)/i,
  /\bCLEAR\s*2\.0\b/i
];

const SENSITIVE_VALUE_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[redacted-openai-key]'],
  [/\b(?:bearer\s+)?[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gi, '[redacted-token]']
];

/**
 * Purpose: build deterministic OpenAI supervised fine-tuning examples from ChatGPT export conversations.
 * Inputs/Outputs: export conversations plus split options -> train/validation examples and a summary.
 * Edge cases: broken branches, non-human/tool messages, or asset-only turns are skipped rather than emitted.
 */
export function buildFineTuneDataset(
  conversations: ChatExportConversation[],
  options: FineTuneDatasetBuildOptions = {}
): FineTuneDatasetBuildResult {
  const validationRatio = normalizeValidationRatio(options.validationRatio);
  const splitSeed = options.splitSeed ?? DEFAULT_SPLIT_SEED;
  const maxMessagesPerExample = options.maxMessagesPerExample ?? DEFAULT_MAX_MESSAGES_PER_EXAMPLE;
  const minimumAssistantCharacters =
    options.minimumAssistantCharacters ?? DEFAULT_MINIMUM_ASSISTANT_CHARACTERS;

  const allExamples: FineTuneDatasetExample[] = [];
  const skippedConversationReasons: Record<string, number> = {};
  const sourceModelCounts: Record<string, number> = {};
  let conversationsWithExamples = 0;

  for (const conversation of conversations) {
    const modelSlug = normalizeModelSlug(conversation.default_model_slug);
    if (modelSlug) {
      sourceModelCounts[modelSlug] = (sourceModelCounts[modelSlug] ?? 0) + 1;
    }

    const conversationExamples = buildExamplesForConversation(conversation, {
      maxMessagesPerExample,
      minimumAssistantCharacters
    });

    if (conversationExamples.skipReason) {
      skippedConversationReasons[conversationExamples.skipReason] =
        (skippedConversationReasons[conversationExamples.skipReason] ?? 0) + 1;
      continue;
    }

    if (conversationExamples.examples.length > 0) {
      conversationsWithExamples += 1;
      allExamples.push(...conversationExamples.examples);
      continue;
    }

    skippedConversationReasons.no_examples_built =
      (skippedConversationReasons.no_examples_built ?? 0) + 1;
  }

  const { trainExamples, validationExamples } = splitExamplesForValidation(
    allExamples,
    validationRatio,
    splitSeed
  );

  const averageMessagesPerExample =
    allExamples.length === 0
      ? 0
      : Number(
          (
            allExamples.reduce((sum, example) => sum + example.messages.length, 0) /
            allExamples.length
          ).toFixed(2)
        );

  return {
    allExamples,
    trainExamples,
    validationExamples,
    summary: {
      conversationsProcessed: conversations.length,
      conversationsWithExamples,
      conversationsSkipped: conversations.length - conversationsWithExamples,
      examplesBuilt: allExamples.length,
      trainExamples: trainExamples.length,
      validationExamples: validationExamples.length,
      averageMessagesPerExample,
      skippedConversationReasons,
      sourceModelCounts
    }
  };
}

/**
 * Purpose: create upload-ready JSONL lines for OpenAI supervised fine-tuning.
 * Inputs/Outputs: dataset examples -> one JSON object per line with only the `messages` field.
 * Edge cases: preserves order exactly so the matching index file can be audited against the JSONL output.
 */
export function serializeExamplesToJsonl(examples: FineTuneDatasetExample[]): string {
  return examples.map((example) => JSON.stringify({ messages: example.messages })).join('\n');
}

/**
 * Purpose: create a sidecar index that maps each dataset line back to its source conversation and target reply.
 * Inputs/Outputs: dataset examples -> JSONL index records for auditing and review.
 * Edge cases: line numbers are 1-based to match common editor and dataset review workflows.
 */
export function serializeIndexToJsonl(examples: FineTuneDatasetExample[]): string {
  return examples
    .map((example, index) =>
      JSON.stringify({
        lineNumber: index + 1,
        sourceConversationId: example.sourceConversationId,
        sourceConversationTitle: example.sourceConversationTitle,
        targetMessageId: example.targetMessageId,
        messageCount: example.messages.length,
        sourceModelSlug: example.sourceModelSlug
      } satisfies FineTuneDatasetIndexRecord)
    )
    .join('\n');
}

interface ConversationBuildOptions {
  maxMessagesPerExample: number;
  minimumAssistantCharacters: number;
}

interface ConversationBuildResult {
  examples: FineTuneDatasetExample[];
  skipReason?: string;
}

function buildExamplesForConversation(
  conversation: ChatExportConversation,
  options: ConversationBuildOptions
): ConversationBuildResult {
  const activeBranchNodeIds = buildActiveBranchNodeIds(conversation);

  //audit Assumption: only the active branch should represent the user's accepted conversation history; failure risk: alternate branches leak contradictory answers into training; expected invariant: `current_node` or the latest leaf identifies the branch tip; handling strategy: skip the conversation when no stable branch can be resolved.
  if (activeBranchNodeIds.length === 0) {
    return { examples: [], skipReason: 'missing_active_branch' };
  }

  const normalizedMessages: NormalizedConversationMessage[] = [];
  let droppedVisibleHumanTurn = false;

  for (const nodeId of activeBranchNodeIds) {
    const node = conversation.mapping?.[nodeId];
    const message = node?.message;
    if (!message) {
      continue;
    }

    const normalizedMessage = normalizeConversationMessage(message);
    if (normalizedMessage === null) {
      if (isVisibleHumanTurn(message)) {
        droppedVisibleHumanTurn = true;
      }
      continue;
    }

    normalizedMessages.push(normalizedMessage);
  }

  const mergedMessages = mergeConsecutiveMessages(normalizedMessages);
  const boundedMessages = trimMessagesToAssistantConversation(mergedMessages);

  //audit Assumption: text-only supervised fine-tuning examples must retain at least one user turn and one assistant reply; failure risk: training lines that end on a user message or omit the question teach malformed chat structure; expected invariant: examples start with `user` and end with `assistant`; handling strategy: reject conversations that cannot satisfy that shape after filtering.
  if (boundedMessages.length < 2) {
    return {
      examples: [],
      skipReason: droppedVisibleHumanTurn ? 'textless_human_turns' : 'too_short_after_filtering'
    };
  }

  const conversationId = normalizeConversationIdentifier(conversation.id);
  const conversationTitle = normalizeConversationTitle(conversation.title);
  const sourceModelSlug = normalizeModelSlug(conversation.default_model_slug);
  const examples: FineTuneDatasetExample[] = [];

  for (let index = 0; index < boundedMessages.length; index += 1) {
    const candidateMessage = boundedMessages[index];
    if (candidateMessage.role !== 'assistant') {
      continue;
    }

    const exampleMessages = trimExampleWindow(
      boundedMessages.slice(0, index + 1),
      options.maxMessagesPerExample
    );

    if (exampleMessages.length < 2) {
      continue;
    }

    const assistantMessage = exampleMessages[exampleMessages.length - 1];
    if (assistantMessage.content.length < options.minimumAssistantCharacters) {
      continue;
    }

    examples.push({
      messages: exampleMessages.map(({ role, content }) => ({ role, content })),
      sourceConversationId: conversationId,
      sourceConversationTitle: conversationTitle,
      targetMessageId: assistantMessage.messageId,
      sourceModelSlug
    });
  }

  return { examples };
}

function buildActiveBranchNodeIds(conversation: ChatExportConversation): string[] {
  const mapping = conversation.mapping ?? {};
  const branchTipNodeId = resolveBranchTipNodeId(conversation);

  if (!branchTipNodeId) {
    return [];
  }

  const lineage: string[] = [];
  const visitedNodeIds = new Set<string>();
  let currentNodeId: string | null = branchTipNodeId;

  while (currentNodeId) {
    //audit Assumption: the export graph should be acyclic along the selected branch; failure risk: malformed data can loop forever and exhaust the process; expected invariant: each node appears at most once in a root-to-leaf walk; handling strategy: abort the walk when a repeat node is detected.
    if (visitedNodeIds.has(currentNodeId)) {
      return [];
    }

    visitedNodeIds.add(currentNodeId);
    lineage.push(currentNodeId);

    const node: ChatExportNode | undefined = mapping[currentNodeId];
    if (!node) {
      return [];
    }

    currentNodeId = node.parent ?? null;
  }

  return lineage.reverse();
}

function resolveBranchTipNodeId(conversation: ChatExportConversation): string | null {
  const mapping = conversation.mapping ?? {};
  const currentNodeId = conversation.current_node ?? null;

  if (currentNodeId && mapping[currentNodeId]) {
    return currentNodeId;
  }

  //audit Assumption: some exports may omit `current_node` while still preserving leaf nodes; failure risk: dropping recoverable conversations reduces dataset quality; expected invariant: the latest visible leaf is the best fallback approximation of the active branch; handling strategy: pick the newest leaf node when `current_node` is absent or invalid.
  const fallbackLeafNode = Object.values(mapping)
    .filter((node): node is ChatExportNode => Boolean(node?.id))
    .filter((node) => (node.children ?? []).length === 0)
    .sort((leftNode, rightNode) => {
      const rightTimestamp = resolveNodeTimestamp(rightNode);
      const leftTimestamp = resolveNodeTimestamp(leftNode);
      return rightTimestamp - leftTimestamp;
    })[0];

  return fallbackLeafNode?.id ?? null;
}

function resolveNodeTimestamp(node: ChatExportNode): number {
  return node.message?.update_time ?? node.message?.create_time ?? Number.MIN_SAFE_INTEGER;
}

function normalizeConversationMessage(
  message: ChatExportMessage
): NormalizedConversationMessage | null {
  const authorRole = message.author?.role ?? null;

  if (authorRole !== 'user' && authorRole !== 'assistant') {
    return null;
  }

  //audit Assumption: only user-visible turns should become supervised chat examples; failure risk: tool requests, Python code cells, or plugin calls poison the fine-tune corpus with hidden orchestration details; expected invariant: retained messages are direct user/assistant chat turns; handling strategy: drop any message not addressed to the public `all` channel.
  if (!isVisibleHumanTurn(message)) {
    return null;
  }

  if (message.status && message.status !== 'finished_successfully') {
    return null;
  }

  const extractedText = extractMessageText(message.content);
  if (!extractedText) {
    return null;
  }

  const sanitizedText = sanitizeTrainingText(extractedText);
  if (!sanitizedText) {
    return null;
  }

  return {
    role: authorRole,
    content: sanitizedText,
    messageId: normalizeMessageIdentifier(message.id)
  };
}

function isVisibleHumanTurn(message: ChatExportMessage): boolean {
  const authorRole = message.author?.role ?? null;
  const recipient = message.recipient ?? 'all';
  return (authorRole === 'user' || authorRole === 'assistant') && recipient === 'all';
}

function extractMessageText(content: ChatExportContent | null | undefined): string | null {
  if (!content) {
    return null;
  }

  const contentType = content?.content_type ?? null;

  if (!contentType) {
    return null;
  }

  if (contentType === 'text') {
    return extractTextLikeValue(content);
  }

  if (contentType === 'code') {
    return extractTextLikeValue(content);
  }

  if (contentType === 'multimodal_text') {
    const textFragments: string[] = [];

    for (const part of content.parts ?? []) {
      if (typeof part === 'string') {
        const trimmedString = part.trim();
        if (trimmedString) {
          textFragments.push(trimmedString);
        }
        continue;
      }

      if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
        const trimmedText = part.text.trim();
        if (trimmedText) {
          textFragments.push(trimmedText);
        }
      }
    }

    return joinTextFragments(textFragments);
  }

  return null;
}

function extractTextLikeValue(content: ChatExportContent): string | null {
  const directTextValue = typeof content.text === 'string' ? content.text : null;
  if (directTextValue?.trim()) {
    return directTextValue.trim();
  }

  const contentValue = typeof content.content === 'string' ? content.content : null;
  if (contentValue?.trim()) {
    return contentValue.trim();
  }

  const textFragments = (content.parts ?? [])
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim())
    .filter(Boolean);

  return joinTextFragments(textFragments);
}

function joinTextFragments(textFragments: string[]): string | null {
  if (textFragments.length === 0) {
    return null;
  }

  return textFragments.join('\n\n').trim() || null;
}

function sanitizeTrainingText(rawText: string): string | null {
  let cleanedText = rawText.replace(/\r\n/g, '\n').trim();

  cleanedText = cleanedText.replace(/[^]+/g, '');
  cleanedText = cleanedText.replace(
    /[✅❌⚡🧠]?\s*\*{0,2}ARCANOS Final(?: Note| Reasoning)?\*{0,2}\s*:?\*{0,2}\s*/gi,
    ''
  );

  for (const marker of HUMAN_CONTENT_MARKERS) {
    const markerIndex = cleanedText.indexOf(marker);
    if (markerIndex !== -1) {
      cleanedText = cleanedText.slice(markerIndex + marker.length).trim();
      break;
    }
  }

  for (const marker of SYSTEM_TAIL_MARKERS) {
    const markerIndex = cleanedText.indexOf(marker);
    if (markerIndex !== -1) {
      cleanedText = cleanedText.slice(0, markerIndex).trim();
    }
  }

  const cleanedLines: string[] = [];
  let insideCodeBlock = false;

  for (const line of cleanedText.split('\n')) {
    const trimmedLine = line.trim();

    if (trimmedLine.startsWith('```')) {
      insideCodeBlock = !insideCodeBlock;
      cleanedLines.push(line);
      continue;
    }

    if (!insideCodeBlock) {
      //audit Assumption: structural audit banners and system headings add noise but no user-facing value; failure risk: keeping them teaches the model to emit internal telemetry; expected invariant: line filtering removes only diagnostic scaffolding; handling strategy: retain normal prose and code blocks verbatim.
      if (
        STRUCTURAL_LINE_PATTERNS.some((pattern) => pattern.test(trimmedLine)) ||
        SYSTEM_LINE_PATTERNS.some((pattern) => pattern.test(trimmedLine))
      ) {
        continue;
      }
    }

    cleanedLines.push(line);
  }

  cleanedText = cleanedLines
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  for (const [pattern, replacement] of SENSITIVE_VALUE_REPLACEMENTS) {
    //audit Assumption: obvious credentials and personal email addresses should not be embedded into long-lived model weights; failure risk: accidental secret memorization; expected invariant: redaction preserves task meaning while removing sensitive literals; handling strategy: replace only high-confidence secret patterns with stable placeholders.
    cleanedText = cleanedText.replace(pattern, replacement);
  }

  return cleanedText.trim() || null;
}

function mergeConsecutiveMessages(
  messages: NormalizedConversationMessage[]
): NormalizedConversationMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const mergedMessages: NormalizedConversationMessage[] = [];

  for (const message of messages) {
    const previousMessage = mergedMessages[mergedMessages.length - 1];

    //audit Assumption: filtering tool/system nodes can leave adjacent messages with the same speaker; failure risk: preserving them separately creates malformed alternation for chat fine-tuning; expected invariant: each visible turn alternates by role after merge; handling strategy: concatenate same-role neighbors with a blank line separator.
    if (previousMessage && previousMessage.role === message.role) {
      previousMessage.content = `${previousMessage.content}\n\n${message.content}`.trim();
      previousMessage.messageId = message.messageId;
      continue;
    }

    mergedMessages.push({ ...message });
  }

  return mergedMessages;
}

function trimMessagesToAssistantConversation(
  messages: NormalizedConversationMessage[]
): NormalizedConversationMessage[] {
  const trimmedMessages = [...messages];

  while (trimmedMessages.length > 0 && trimmedMessages[0].role !== 'user') {
    trimmedMessages.shift();
  }

  while (trimmedMessages.length > 0 && trimmedMessages[trimmedMessages.length - 1].role !== 'assistant') {
    trimmedMessages.pop();
  }

  return trimmedMessages;
}

function trimExampleWindow(
  messages: NormalizedConversationMessage[],
  maxMessagesPerExample: number
): NormalizedConversationMessage[] {
  const slicedMessages = messages.slice(-maxMessagesPerExample);
  return trimMessagesToAssistantConversation(slicedMessages);
}

function splitExamplesForValidation(
  examples: FineTuneDatasetExample[],
  validationRatio: number,
  splitSeed: string
): Pick<FineTuneDatasetBuildResult, 'trainExamples' | 'validationExamples'> {
  const trainExamples: FineTuneDatasetExample[] = [];
  const validationExamples: FineTuneDatasetExample[] = [];

  for (const example of examples) {
    const splitBucket = buildDeterministicBucketValue(
      `${splitSeed}:${example.sourceConversationId}:${example.targetMessageId}`
    );

    if (splitBucket < validationRatio) {
      validationExamples.push(example);
      continue;
    }

    trainExamples.push(example);
  }

  return { trainExamples, validationExamples };
}

function buildDeterministicBucketValue(seedMaterial: string): number {
  const hash = createHash('sha256').update(seedMaterial).digest('hex').slice(0, 8);
  const bucketInteger = Number.parseInt(hash, 16);
  return bucketInteger / 0xffffffff;
}

function normalizeValidationRatio(validationRatio: number | undefined): number {
  const ratio = validationRatio ?? DEFAULT_VALIDATION_RATIO;

  //audit Assumption: validation splits outside the `[0, 0.5]` range are almost always operator error for this workflow; failure risk: a bad flag can silently produce an empty training set or a meaningless validation split; expected invariant: ratio stays inside a conservative range; handling strategy: fail fast with a clear error instead of coercing a surprising value.
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
    throw new Error(`validationRatio must be between 0 and 0.5. Received: ${String(validationRatio)}`);
  }

  return ratio;
}

function normalizeConversationIdentifier(conversationId: string | null | undefined): string {
  return conversationId?.trim() || 'unknown-conversation';
}

function normalizeConversationTitle(title: string | null | undefined): string {
  return title?.trim() || 'Untitled conversation';
}

function normalizeMessageIdentifier(messageId: string | null | undefined): string {
  return messageId?.trim() || 'unknown-message';
}

function normalizeModelSlug(modelSlug: string | null | undefined): string | null {
  return modelSlug?.trim() || null;
}
