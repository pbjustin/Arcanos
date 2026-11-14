import { resolveGamingAnswerPolicy } from '@shared/gaming/gamingAnswerPolicy.js';
import { buildGamingRequestRequirements } from '@shared/gaming/gamingRetrievalPolicy.js';

const ACTION_VERBS = 'activate|buy|choose|collect|confirm|deploy|enter|equip|follow|launch|open|pay|place|press|register|select|travel|turn|unlock|use|visit|wait';
const ACTION = new RegExp('^(?:' + ACTION_VERBS + ')\\s+\\S', 'iu');
const ALTERNATIVE_ACTION = new RegExp('\\bor\\s+(?:' + ACTION_VERBS + ')\\b', 'iu');
const AMBIGUOUS_ACTION = /[\x60[\]<>\\_:;?!*]|\b(?:if|unless|until|when|whenever|before|after|while|otherwise|instead|either|optionally|could|should|must|or else)\b/iu;
const QUOTE_DELIMITER = /["“”‘]|(?<![\p{L}\p{N}])['’]|['’](?![\p{L}\p{N}])/u;
const LIST_PROHIBITION = /\b(?:no|without(?: (?:a|any))?|(?:do not|don['’]t) use(?: (?:a|any))?) (?:numbering|(?:numbered )?(?:lists?|bullets)|numbered steps?)\b/iu;
const PROSE_REQUEST = /\b(?:in (?:prose|(?:a |one |a single )paragraph)|(?:do not|don['’]t) (?:number (?:lists?|numbered steps|the steps|bullets)|use the steps))\b/iu;
const PROCEDURE = /^(To (?:start|begin|get started with) [^,.\n]{1,140}), ([^.\n]{1,1400})\.(?= |$)/iu;
const INLINE_SOURCE_LIMIT = / (The (?:supplied|selected|available) excerpts) (explain|cover) ([^.!?\n[\]]{1,220}), but do not establish ([^.!?\n[\],;:]{1,220})\. (\[1\])$/u;
const STANDALONE_SOURCE_LIMIT = /^([A-Z][^.!?\n[\];:]{1,300}) are not established here\.$/u;
const SINGLE_SOURCE = /^\*\*Source:\*\* \[1\] [^\n[\]]*\[[^\n[\]]+\]\(https:\/\/[^\s)]+\)\.$/u;
const LIVE_LIMIT = /^I (?:can['’]t|cannot) verify live game state here\.$/u;

/** Merge the two reports of gaps in the same excerpt set, retaining its original citation. */
function consolidateSourceLimits(continuation: string, tail: string[]): { mechanics: string; tail: string[] } {
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
    tail: ['**Limitations**', limitations, ...(liveLimit ? [liveLimit] : []), source]
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
  if (!procedure || !/,\s+(?:and\s+)?then\s+\S/iu.test(procedure[2])) return answer;
  // Quoted labels can contain action-like commas. Keep the sentence intact.
  // Apostrophes inside words, such as “ship’s”, do not delimit a label.
  if (QUOTE_DELIMITER.test(procedure[2])) return answer;

  const continuation = paragraphs[procedureIndex].slice(procedure[0].length);
  // A marker immediately after that sentence stays with the list. Leave
  // more complex citation syntax alone rather than splitting its target.
  const adjacentCitation = /^ (\[\d+(?:,\s*\d+)*\])(?= |$)/u.exec(continuation);
  if (continuation.trimStart().startsWith('[') && !adjacentCitation) return answer;
  const actions = procedure[2].split(', ').map(clause => clause.replace(/^(?:and )?then\s+/iu, ''));
  if (actions.length < 2 || actions.length > 8
    || actions.some(action => !ACTION.test(action) || ALTERNATIVE_ACTION.test(action)
      || AMBIGUOUS_ACTION.test(action.replace(/\*\*([^*\n]+)\*\*/gu, '$1')))) return answer;

  const tail = paragraphs.slice(procedureIndex + 1);
  const remainingProse = continuation.slice(adjacentCitation?.[0].length ?? 0);
  const formatted = singleSource ? consolidateSourceLimits(remainingProse, tail) : { mechanics: remainingProse, tail };
  const steps = actions.map((action, index) => (index + 1) + '. ' + action[0].toUpperCase() + action.slice(1) + '.').join('\n');
  const mechanics = formatted.mechanics.trim();
  return [...paragraphs.slice(0, procedureIndex), procedure[1] + ':', steps + (adjacentCitation?.[0] ?? ''),
    ...(mechanics ? [mechanics] : []), ...formatted.tail].join('\n\n');
}
