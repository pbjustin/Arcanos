/**
 * Mid-Layer Translator
 *
 * Post-processing layer that strips system/audit artifacts from AI output
 * and reshapes it into natural, human-facing language.
 *
 * Design guarantees:
 * - Does NOT add new information
 * - Does NOT fix wrong answers
 * - Does NOT reason
 * - Only removes system voice, preserves correctness, reshapes tone
 */

export type Intent = 'fact' | 'story' | 'advice' | 'code' | 'greeting' | 'default';

export interface SystemOutput {
  raw: string;
  metadata?: Record<string, unknown>;
}

// Words/phrases that, when found on a line, mark it as system junk (whole line removed)
const SYSTEM_LINE_INDICATORS: RegExp[] = [
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
  /pattern_\d{5,}/i,
  /memory_shell_\d/i,
  /audit.?safe/i,
  /kernel rule set/i,
  /resilience patch/i,
  /fallback handler/i,
  /rollback handler/i,
  /session lock fallback/i,
  /logic dispatch/i,
  /goal articulation/i,
  /routing stages/i,
  /source verification/i,
  /reasoning path/i,
  /compliance status/i,
  /security measures applied/i,
  /all systems\s*✅/i,
  /integrity is a system/i,
  /auditable final response/i,
  /audited,?\s*finalized response/i,
  /memory patterns and reinforced/i,
  /system integrity checks/i,
  /modular memory system/i,
  /persisted via/i,
  /verified via/i,
  /interpreted and enforced/i,
  /log entry:\s*\d/i,
  /🧠v\d/,
];

// Lines matching these patterns are decorative/structural system artifacts
const STRUCTURAL_LINE_PATTERNS: RegExp[] = [
  /^[═─━\-]{3,}\s*$/,           // decorative borders
  /^---\s*$/,                     // horizontal rules
  /^#{1,3}\s*[🧠📋🔍📊🎯🛡️⚡✅❌🔒]/,  // emoji-headed sections
  /^[🧠📋🔍📊🎯🛡️⚡✅❌🔒]\s+[A-Z]/,   // emoji-led labels
  /^>\s*".*🧠/,                   // quoted system mottos
];

// Section headers after which everything is system content
const SYSTEM_TAIL_MARKERS = [
  '### 🛡️ Audit Summary',
  '### Audit Summary',
  '🛡️ Audit Summary',
  '📊 COMPLIANCE STATUS',
  '🎯 STRUCTURED RECOMMENDATIONS',
];

// Section headers that precede human content
const HUMAN_CONTENT_MARKERS = [
  '### 🧠 Answer',
  '### Answer',
  '### 📖 Narrative Output',
  '### Narrative Output',
];

// Preamble patterns: remove "Understood. Here is your..." style intros
const PREAMBLE_PATTERNS: RegExp[] = [
  /^understood\.?\s*/i,
  /^here is (?:your|the|my)\b.*?(?::|—|-)\s*/i,
  /^based on\b.*?(?::|—|-)\s*/i,
];

// Intent detection keywords
const INTENT_KEYWORDS: Record<Intent, RegExp[]> = {
  greeting: [
    /^(hi|hello|hey|sup|yo|what'?s up|howdy|good (morning|afternoon|evening))\b/i,
  ],
  fact: [
    /\b(what is|who is|when did|where is|how many|how much|define|what are)\b/i,
  ],
  code: [
    /\b(code|function|class|script|debug|error|bug|compile|import|export|npm|pip|git)\b/i,
    /```/,
  ],
  story: [
    /\b(tell me about|explain|describe|walk me through|story|history of)\b/i,
  ],
  advice: [
    /\b(should i|how do i|how can i|best way to|recommend|suggest|help me|tips)\b/i,
  ],
  default: [],
};

/**
 * Mid-layer responsible for translating
 * system/audit-heavy AI output into human-facing language.
 */
export class MidLayerTranslator {
  /**
   * Entry point — translate system output to human-facing text.
   */
  static translate(output: SystemOutput, intent?: Intent): string {
    const resolvedIntent = intent ?? this.detectIntent(output.raw);
    let text = output.raw;

    // Step 1: Extract human section if markers exist
    text = this.extractHumanContent(text);

    // Step 2: Cut off system tail sections
    text = this.cutSystemTail(text);

    // Step 3: Remove system lines
    text = this.removeSystemLines(text);

    // Step 4: Strip preamble
    text = this.stripPreamble(text);

    // Step 5: If stripping removed everything, the output was pure system junk.
    // Return a natural fallback rather than an empty string.
    if (!text.trim()) {
      return this.getFallbackForIntent(resolvedIntent);
    }

    // Step 6: Humanize contractions
    text = this.humanize(text);

    // Step 7: Shape by intent
    return this.finalize(text, resolvedIntent);
  }

  /**
   * When the AI produced only system artifacts with no human content,
   * return a natural fallback based on intent.
   */
  private static getFallbackForIntent(intent: Intent): string {
    switch (intent) {
      case 'greeting':
        return "Hey! What's on your mind?";
      case 'fact':
        return "I'm not sure about that one. Could you give me a bit more context?";
      case 'code':
        return "I'd be happy to help with that. Could you share more details about what you're working on?";
      case 'advice':
        return "Good question! Can you tell me a bit more so I can give you a useful answer?";
      case 'story':
        return "That's an interesting topic. What specifically would you like to know?";
      default:
        return "Hey, I'm here! What can I help you with?";
    }
  }

  /**
   * Detect intent from text.
   */
  static detectIntent(text: string): Intent {
    const normalized = text.trim();
    const intentOrder: Intent[] = ['greeting', 'code', 'fact', 'story', 'advice'];
    for (const intent of intentOrder) {
      for (const pattern of INTENT_KEYWORDS[intent]) {
        if (pattern.test(normalized)) {
          return intent;
        }
      }
    }
    return 'default';
  }

  /**
   * Detect intent from the user's original message (before AI processing).
   */
  static detectIntentFromUserMessage(userMessage: string): Intent {
    return this.detectIntent(userMessage);
  }

  /**
   * If known human-content markers exist, take content after them.
   */
  private static extractHumanContent(raw: string): string {
    for (const marker of HUMAN_CONTENT_MARKERS) {
      const idx = raw.indexOf(marker);
      if (idx !== -1) {
        return raw.substring(idx + marker.length).trim();
      }
    }
    return raw;
  }

  /**
   * Cut everything after system tail markers (audit summaries, compliance blocks).
   */
  private static cutSystemTail(text: string): string {
    let result = text;
    for (const marker of SYSTEM_TAIL_MARKERS) {
      const idx = result.indexOf(marker);
      if (idx !== -1) {
        result = result.substring(0, idx);
      }
    }
    return result.trim();
  }

  /**
   * Line-by-line filtering: remove lines that contain system indicators
   * or match structural patterns. Preserves code blocks untouched.
   */
  private static removeSystemLines(text: string): string {
    const lines = text.split('\n');
    const kept: string[] = [];
    let inCodeBlock = false;

    for (const line of lines) {
      // Preserve code blocks entirely
      if (line.trimStart().startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        kept.push(line);
        continue;
      }
      if (inCodeBlock) {
        kept.push(line);
        continue;
      }

      // Check if this line is a system artifact
      const trimmed = line.trim();
      if (!trimmed) {
        kept.push(line);
        continue;
      }

      // Check structural patterns
      if (STRUCTURAL_LINE_PATTERNS.some(p => p.test(trimmed))) {
        continue; // skip this line
      }

      // Check system indicator words
      if (SYSTEM_LINE_INDICATORS.some(p => p.test(trimmed))) {
        continue; // skip this line
      }

      kept.push(line);
    }

    // Collapse 3+ blank lines into 2
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  /**
   * Remove AI preamble phrases like "Understood. Here is your..."
   */
  private static stripPreamble(text: string): string {
    let result = text;
    for (const pattern of PREAMBLE_PATTERNS) {
      result = result.replace(pattern, '');
    }
    return result.trim();
  }

  /**
   * Humanize contractions for a more natural tone.
   */
  private static humanize(text: string): string {
    return text
      .replace(/\bIt is\b/g, "It's")
      .replace(/\bit is\b/g, "it's")
      .replace(/\bDo not\b/g, "Don't")
      .replace(/\bdo not\b/g, "don't")
      .replace(/\bCannot\b/g, "Can't")
      .replace(/\bcannot\b/g, "can't")
      .replace(/\bWill not\b/g, "Won't")
      .replace(/\bwill not\b/g, "won't")
      .replace(/\bI am\b/g, "I'm")
      .replace(/\bYou are\b/g, "You're")
      .replace(/\byou are\b/g, "you're")
      .replace(/\bThey are\b/g, "They're")
      .replace(/\bthey are\b/g, "they're")
      .replace(
        /\b(certainly,?|it is important to note that|in conclusion,?|as an ai,?|as a language model,?)\b/gi,
        ''
      )
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  /**
   * Final shaping based on intent.
   */
  private static finalize(text: string, intent: Intent): string {
    if (!text) return '';

    if (intent === 'fact' && text.length >= 200) {
      const paragraphs = text.split('\n\n').filter(p => p.trim().length > 0);
      return this.capitalize(paragraphs[0] ?? text);
    }

    if (intent === 'code') {
      return text; // preserve formatting exactly
    }

    if (intent === 'greeting') {
      const sentences = text.match(/[^.!?]+[.!?]+/g);
      if (sentences && sentences.length > 3) {
        return this.capitalize(sentences.slice(0, 2).join('').trim());
      }
    }

    return this.capitalize(text);
  }

  private static capitalize(text: string): string {
    if (!text) return '';
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
}
