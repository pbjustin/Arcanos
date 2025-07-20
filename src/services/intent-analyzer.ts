// Intent analyzer for ARCANOS routing
// Determines whether input contains narrative intent or validation request

export type IntentType = 'WRITE' | 'AUDIT' | 'DIAGNOSTIC' | 'UNKNOWN';

export interface IntentAnalysisResult {
  intent: IntentType;
  confidence: number;
  reasoning: string;
}

export class IntentAnalyzer {
  // Keywords that indicate narrative/writing intent
  private readonly narrativeKeywords = [
    'write', 'create', 'generate', 'compose', 'draft', 'tell', 'story', 'narrative',
    'describe', 'explain', 'elaborate', 'detail', 'expand', 'develop', 'craft',
    'produce', 'make', 'build', 'design', 'invent', 'imagine', 'envision'
  ];

  // Keywords that indicate validation/audit intent
  private readonly validationKeywords = [
    'validate', 'audit', 'check', 'verify', 'review', 'examine', 'inspect',
    'assess', 'evaluate', 'analyze', 'test', 'confirm', 'ensure', 'validate',
    'quality', 'correct', 'accurate', 'proper', 'valid', 'compliance'
  ];

  // Keywords that indicate diagnostic intent
  private readonly diagnosticKeywords = [
    'memory', 'ram', 'cpu', 'processor', 'disk', 'storage', 'network', 'bandwidth',
    'system', 'health', 'performance', 'uptime', 'processes', 'diagnostics',
    'load', 'usage', 'connections', 'ports', 'listeners', 'available', 'free',
    'used', 'busy', 'active', 'real-time', 'monitor', 'sweep'
  ];

  // Phrases that strongly indicate narrative intent
  private readonly narrativePhrases = [
    'tell me about', 'write about', 'create a', 'generate a', 'compose a',
    'help me write', 'can you write', 'please write', 'describe how',
    'explain what', 'tell the story', 'create content'
  ];

  // Phrases that strongly indicate validation intent
  private readonly validationPhrases = [
    'check if', 'verify that', 'validate this', 'audit this', 'review this',
    'is this correct', 'is this valid', 'does this comply', 'examine this',
    'assess whether', 'confirm that'
  ];

  // Phrases that strongly indicate diagnostic intent
  private readonly diagnosticPhrases = [
    'check available memory', 'show ram usage', 'run memory diagnostics',
    'memory usage', 'cpu performance check', 'how busy is the processor',
    'show cpu core usage', 'load average', 'real-time cpu diagnostics',
    'disk usage report', 'available disk space', 'how much storage',
    'largest directories', 'network speed test', 'bandwidth usage',
    'active network connections', 'open ports', 'system health check',
    'active processes', 'uptime and resource', 'diagnostic sweep',
    'run diagnostics', 'system status', 'performance check'
  ];

  analyzeIntent(input: string): IntentAnalysisResult {
    const normalizedInput = input.toLowerCase().trim();
    
    let narrativeScore = 0;
    let auditScore = 0;
    let diagnosticScore = 0;
    let reasoning = '';

    // Check for diagnostic phrase indicators first (highest priority)
    for (const phrase of this.diagnosticPhrases) {
      if (normalizedInput.includes(phrase)) {
        diagnosticScore += 3;
        reasoning += `Contains diagnostic phrase: "${phrase}". `;
      }
    }

    // Check for strong phrase indicators
    for (const phrase of this.narrativePhrases) {
      if (normalizedInput.includes(phrase)) {
        narrativeScore += 3;
        reasoning += `Contains narrative phrase: "${phrase}". `;
      }
    }

    for (const phrase of this.validationPhrases) {
      if (normalizedInput.includes(phrase)) {
        auditScore += 3;
        reasoning += `Contains validation phrase: "${phrase}". `;
      }
    }

    // Check for diagnostic keyword indicators
    for (const keyword of this.diagnosticKeywords) {
      if (normalizedInput.includes(keyword)) {
        diagnosticScore += 1;
        reasoning += `Contains diagnostic keyword: "${keyword}". `;
      }
    }

    // Check for keyword indicators
    for (const keyword of this.narrativeKeywords) {
      if (normalizedInput.includes(keyword)) {
        narrativeScore += 1;
        reasoning += `Contains narrative keyword: "${keyword}". `;
      }
    }

    for (const keyword of this.validationKeywords) {
      if (normalizedInput.includes(keyword)) {
        auditScore += 1;
        reasoning += `Contains validation keyword: "${keyword}". `;
      }
    }

    // Question patterns that suggest diagnostic intent
    if (normalizedInput.startsWith('show') || normalizedInput.startsWith('check') ||
        normalizedInput.startsWith('run') || normalizedInput.startsWith('how much') ||
        normalizedInput.startsWith('how busy') || normalizedInput.startsWith('list')) {
      diagnosticScore += 2;
      reasoning += 'Question pattern suggests diagnostic intent. ';
    }

    // Question patterns that suggest narrative intent
    if (normalizedInput.startsWith('what is') || normalizedInput.startsWith('how to') || 
        normalizedInput.startsWith('can you explain') || normalizedInput.startsWith('tell me')) {
      narrativeScore += 2;
      reasoning += 'Question pattern suggests narrative intent. ';
    }

    // Question patterns that suggest validation intent
    if (normalizedInput.includes('is this correct') || normalizedInput.includes('is this right') ||
        normalizedInput.includes('does this work') || normalizedInput.includes('is this valid')) {
      auditScore += 2;
      reasoning += 'Question pattern suggests validation intent. ';
    }

    // Determine final intent
    const totalScore = narrativeScore + auditScore + diagnosticScore;
    let intent: IntentType;
    let confidence: number;

    if (totalScore === 0) {
      intent = 'UNKNOWN';
      confidence = 0;
      reasoning += 'No clear indicators found.';
    } else if (diagnosticScore > narrativeScore && diagnosticScore > auditScore) {
      intent = 'DIAGNOSTIC';
      confidence = Math.min(diagnosticScore / totalScore, 0.95);
      reasoning += `Diagnostic score: ${diagnosticScore}, Narrative: ${narrativeScore}, Audit: ${auditScore}.`;
    } else if (narrativeScore > auditScore) {
      intent = 'WRITE';
      confidence = Math.min(narrativeScore / totalScore, 0.95);
      reasoning += `Narrative score: ${narrativeScore}, Audit: ${auditScore}, Diagnostic: ${diagnosticScore}.`;
    } else if (auditScore > narrativeScore) {
      intent = 'AUDIT';
      confidence = Math.min(auditScore / totalScore, 0.95);
      reasoning += `Audit score: ${auditScore}, Narrative: ${narrativeScore}, Diagnostic: ${diagnosticScore}.`;
    } else {
      // Tied scores - default to UNKNOWN with low confidence
      intent = 'UNKNOWN';
      confidence = 0.3;
      reasoning += `Tied scores - unclear intent.`;
    }

    return {
      intent,
      confidence,
      reasoning: reasoning.trim()
    };
  }
}