export interface NLPInterpreterConfig {
  enablePromptTranslation?: boolean;
  autoResolveIntents?: boolean;
  fallbackToStructuredMode?: boolean;
}

export interface NLPParseResult {
  intent: 'audit' | 'diagnostic' | 'logic' | 'unknown';
  text: string;
  fallback?: boolean;
}

class NLPInterpreter {
  private config: NLPInterpreterConfig;

  constructor(config: NLPInterpreterConfig = {}) {
    this.config = config;
  }

  parse(message: string): NLPParseResult {
    const text = this.config.enablePromptTranslation ? this.translate(message) : message;
    let intent: NLPParseResult['intent'] = 'unknown';

    if (this.config.autoResolveIntents) {
      const lower = text.toLowerCase();
      if (/\baudit|validate|compliance/.test(lower)) intent = 'audit';
      else if (/\bdiagnos|debug|health/.test(lower)) intent = 'diagnostic';
      else if (lower.trim().length > 0) intent = 'logic';
    }

    if (intent === 'unknown' && this.config.fallbackToStructuredMode) {
      return { intent: 'logic', text, fallback: true };
    }

    return { intent, text };
  }

  private translate(text: string): string {
    // Placeholder for real translation logic
    return text;
  }
}

let instance: NLPInterpreter | null = null;

export function installNLPInterpreter(config: NLPInterpreterConfig = {}): void {
  if (!instance) {
    instance = new NLPInterpreter(config);
    if (config.enablePromptTranslation !== false) {
      console.log('[NLP-INTERPRETER] Prompt translation enabled');
    }
    console.log('[NLP-INTERPRETER] Module installed');
  }
}

export function getNLPInterpreter(): NLPInterpreter | null {
  return instance;
}
