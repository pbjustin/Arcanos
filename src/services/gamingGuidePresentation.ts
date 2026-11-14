import { resolveGamingAnswerPolicy } from '@shared/gaming/gamingAnswerPolicy.js';
import { buildGamingRequestRequirements } from '@shared/gaming/gamingRetrievalPolicy.js';

const ACTION_VERBS = 'activate|buy|choose|collect|confirm|deploy|enter|equip|follow|launch|open|pay|place|press|register|select|travel|turn|unlock|use|visit|wait';
const ACTION = new RegExp('^(?:' + ACTION_VERBS + ')\\s+\\S', 'iu');
const ALTERNATIVE_ACTION = new RegExp('\\bor\\s+(?:' + ACTION_VERBS + ')\\b', 'iu');
const AMBIGUOUS_ACTION = /[\x60[\]<>\\_:;?!*]|\b(?:if|unless|until|when|whenever|before|after|while|otherwise|instead|either|optionally|could|should|must|or else)\b/iu;
const QUOTE_DELIMITER = /["“”‘]|(?<![\p{L}\p{N}])['’]|['’](?![\p{L}\p{N}])/u;
const LIST_PROHIBITION = /\b(?:no|without(?: (?:a|any))?|(?:do not|don['’]t) use(?: (?:a|any))?) (?:numbering|(?:numbered )?(?:lists?|bullets)|numbered steps?)\b/iu;
const PROSE_REQUEST = /\b(?:in (?:prose|(?:a |one |a single )paragraph)|(?:do not|don['’]t) (?:number (?:lists?|numbered steps|the steps|bullets)|use the steps))\b/iu;
const PROCEDURE = /^(To (?:start|begin|get started with) [^,.()\n]{1,140}), ([^.\n]{1,1400})\.(?= |$)/iu;
const ADJACENT_CITATIONS = /^(?:[ \t]+\[\d+(?:,[ \t]*\d+)*\])+(?=[ \t]|$)/u;
const POSSIBLE_ABBREVIATION = /(?:^|\s)(?:\p{L}|st|mt|ft|mk|no|dr|mr|mrs|ms|prof|capt|lt|sgt|gen|sr|jr|vs|etc)$/iu;
const INLINE_SOURCE_LIMIT = / (The (?:supplied|selected|available) excerpts) (explain|cover) ([^.!?\n[\]]{1,220}), but do not establish ([^.!?\n[\],;:]{1,220})\. (\[1\])$/u;
const STANDALONE_SOURCE_LIMIT = /^([A-Z][^.!?\n[\];:]{1,300}) are not established here\.$/u;
const SINGLE_SOURCE = /^\*\*Source:\*\* \[1\] [^\n[\]]*\[[^\n[\]]+\]\(https:\/\/[^\s)]+\)\.$/u;
const LIVE_LIMIT = /^I (?:can['’]t|cannot) verify live game state here\.$/u;

/** Only commas outside balanced parentheses can introduce another action. */
function splitActionClauses(sequence: string): string[] | undefined {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < sequence.length; index += 1) {
    const character = sequence[index];
    if (character === '(') depth += 1;
    if (character === ')') {
      if (depth === 0) return undefined;
      depth -= 1;
    }
    if (depth === 0 && character === ',' && sequence[index + 1] === ' ') {
      clauses.push(sequence.slice(start, index));
      start = index + 2;
    }
  }
  if (depth !== 0) return undefined;
  clauses.push(sequence.slice(start));
  return clauses;
}

/** Merge the two reports of gaps in the same excerpt set, retaining its original citation. */
function consolidateSourceLimits(continuation: string, tail: string[]): {
  mechanics: string;
  tail: string[];
  sharedCitation?: string;
} {
  const [source, laterLimit, liveLimit] = tail;
  const inline = INLINE_SOURCE_LIMIT.exec(continuation);
  const standalone = STANDALONE_SOURCE_LIMIT.exec(laterLimit ?? '');
  if (!inline || !standalone || !SINGLE_SOURCE.test(source ?? '')
    || (tail.length !== 2 && !(tail.length === 3 && LIVE_LIMIT.test(liveLimit)))) return { mechanics: continuation, tail };

  const [, subject, scopeVerb, scope, broadGaps, citation] = inline;
  // Conjunctions within a detail can make its scope ambiguous. Preserve these
  // unchanged rather than mistake part of a noun phrase for a separate gap.
  const general = broadGaps.split(/\s+or\s+(?=(?:the|every|any|all|exact)\b)/u);
  const specific = standalone[1].split(/,\s+(?:and\s+)?/u);
  if (general.length !== 2 || specific.length < 2
    || [...general, ...specific].some(gap => /\b(?:and|or)\b|[*\x60<>]/iu.test(gap))
    || !/^(?:Exact|Full|Complete|Additional|Later|Current|Specific|Required)\s/u.test(specific[0])) {
    return { mechanics: continuation, tail };
  }
  specific[0] = specific[0][0].toLowerCase() + specific[0].slice(1);
  const gaps = [...new Set([...general, ...specific])];
  const gapList = new Intl.ListFormat('en', { type: 'disjunction' }).format(gaps);
  const limitations = subject + ' ' + scopeVerb + ' ' + scope + ', but do not establish ' + gapList + '. ' + citation;
  return {
    mechanics: continuation.slice(0, inline.index),
    tail: ['**Limitations**', limitations, ...(liveLimit ? [liveLimit] : []), source],
    sharedCitation: citation
  };
}

/** Format an unambiguous ordered guide without rewriting its gameplay clauses. */
export function formatGamingGuidePresentation(input: {
  answer: string;
  prompt: string;
  game: string;
  singleSource: boolean;
  leadingQualifications: readonly string[];
}): string {
  const { answer, prompt, game, singleSource, leadingQualifications } = input;
  if (LIST_PROHIBITION.test(prompt) || PROSE_REQUEST.test(prompt)) return answer;
  if (resolveGamingAnswerPolicy({ prompt }).task !== 'walkthrough'
    && !buildGamingRequestRequirements({ prompt, game }).some(requirement => requirement.procedure === 'start')) return answer;

  const paragraphs = answer.split('\n\n');
  const procedureIndex = paragraphs.findIndex(paragraph => !leadingQualifications.includes(paragraph));
  if (procedureIndex < 0) return answer;
  const procedure = PROCEDURE.exec(paragraphs[procedureIndex]);
  if (!procedure) return answer;
  // Quoted labels can contain action-like commas. Keep the sentence intact.
  // Apostrophes inside words, such as “ship’s”, do not delimit a label.
  if (QUOTE_DELIMITER.test(procedure[2])) return answer;

  const continuation = paragraphs[procedureIndex].slice(procedure[0].length);
  // Keep the entire adjacent citation group together. Leave more complex
  // citation syntax alone when the plain references cover only part of it.
  const adjacentCitations = ADJACENT_CITATIONS.exec(continuation)?.[0] ?? '';
  const remainingProse = continuation.slice(adjacentCitations.length);
  if ((!singleSource && !adjacentCitations) || /^\s*[[(]/u.test(remainingProse)) return answer;
  // The first period may be part of a name or title that continues after it.
  if (!adjacentCitations && remainingProse.trim() && POSSIBLE_ABBREVIATION.test(procedure[2])) return answer;
  const clauses = splitActionClauses(procedure[2]);
  if (!clauses) return answer;
  const hasThen = clauses.slice(1).some(clause => /^(?:and )?then\s+\S/iu.test(clause));
  // The starting instruction can also introduce a complete series of three or
  // more actions with a final “and” and no “then”.
  if (!hasThen) {
    const lastIndex = clauses.length - 1;
    if (clauses.length < 3 || !/^and\s+\S/iu.test(clauses[lastIndex])) return answer;
    clauses[lastIndex] = clauses[lastIndex].replace(/^and\s+/iu, '');
  }
  const actions = clauses.map(clause => clause.replace(/^(?:and )?then\s+/iu, ''));
  if (actions.length < 2 || actions.length > 8
    || actions.some(action => !ACTION.test(action) || ALTERNATIVE_ACTION.test(action)
      || AMBIGUOUS_ACTION.test(action.replace(/\*\*([^*\n]+)\*\*/gu, '$1')))) return answer;

  const tail = paragraphs.slice(procedureIndex + 1);
  const formatted = singleSource ? consolidateSourceLimits(remainingProse, tail) : { mechanics: remainingProse, tail };
  const steps = actions.map((action, index) => (index + 1) + '. ' + action[0].toUpperCase() + action.slice(1) + '.').join('\n');
  const mechanics = formatted.mechanics.trim();
  // Before consolidation the same marker covered the original gameplay
  // paragraph and its limitation. Retain it on the now-separate blocks.
  const stepCitations = adjacentCitations || (formatted.sharedCitation ? ' ' + formatted.sharedCitation : '');
  const mechanicsCitation = formatted.sharedCitation && !mechanics.includes(formatted.sharedCitation)
    ? ' ' + formatted.sharedCitation : '';
  return [...paragraphs.slice(0, procedureIndex), procedure[1] + ':', steps + stepCitations,
    ...(mechanics ? [mechanics + mechanicsCitation] : []), ...formatted.tail].join('\n\n');
}
