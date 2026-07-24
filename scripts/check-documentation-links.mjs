#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  resolve,
} from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = realpathSync(process.cwd());
const maintainedMarkdownExclusions = [
  'docs/audits/',
];
const defaultOptions = {
  concurrency: 8,
  jsonReport: '',
  localOnly: false,
  requestTimeoutMs: 10_000,
  retries: 2,
};
const externalRequestHeaders = {
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
  Connection: 'close',
  'User-Agent': 'Arcanos-Documentation-Link-Audit/1.0',
};
const permanentFailureReasons = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_NONAME',
  'EBADNAME',
  'ENODATA',
  'ENOTFOUND',
  'ERR_INVALID_URL',
  'ERR_UNESCAPED_CHARACTERS',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'embedded-credentials',
  'private-host',
  'too-many-redirects',
  'unsupported-protocol',
]);

function usage() {
  process.stdout.write(`Usage: node scripts/check-documentation-links.mjs [options]

Options:
  --local-only          Validate local files and anchors without network requests
  --concurrency <n>     Maximum simultaneous external checks (default: 8)
  --timeout-ms <n>      Per-request timeout in milliseconds (default: 10000)
  --retries <n>         Retries for transient external failures (default: 2)
  --json-report <path>  Write a machine-readable report
  --help                Show this help
`);
}

function integerOption(name, rawValue, minimum, maximum) {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseArguments(argv) {
  const options = { ...defaultOptions };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const [name, inlineValue] = argument.split('=', 2);
    const nextValue = () => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${name} requires a value`);
      }
      return argv[index];
    };

    switch (name) {
      case '--concurrency':
        options.concurrency = integerOption(name, nextValue(), 1, 32);
        break;
      case '--help':
        usage();
        process.exit(0);
        break;
      case '--json-report':
        options.jsonReport = nextValue();
        break;
      case '--local-only':
        options.localOnly = true;
        break;
      case '--retries':
        options.retries = integerOption(name, nextValue(), 0, 5);
        break;
      case '--timeout-ms':
        options.requestTimeoutMs = integerOption(name, nextValue(), 1_000, 60_000);
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return options;
}

function trackedMarkdownFiles(root = repositoryRoot) {
  const result = spawnSync(
    'git',
    ['ls-files', '-z', '--', '*.md'],
    { cwd: root, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || 'git ls-files failed');
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((path) => path.replaceAll('\\', '/'))
    .filter((path) => (
      !maintainedMarkdownExclusions.some((prefix) => path.startsWith(prefix))
      && existsSync(resolve(root, path))
    ));
}

function maskRange(characters, start, end) {
  for (let index = start; index < end; index += 1) {
    if (characters[index] !== '\r' && characters[index] !== '\n') {
      characters[index] = ' ';
    }
  }
}

function sourceLines(source) {
  const lines = [];
  let start = 0;

  while (start < source.length) {
    let end = source.indexOf('\n', start);
    if (end < 0) {
      end = source.length;
    } else {
      end += 1;
    }
    const contentEnd = source[end - 1] === '\n'
      ? end - (source[end - 2] === '\r' ? 2 : 1)
      : end;
    lines.push({
      content: source.slice(start, contentEnd),
      contentEnd,
      end,
      start,
    });
    start = end;
  }

  return lines;
}

function maskMarkdownBlocks(source) {
  const characters = source.split('');

  for (let start = source.indexOf('<!--'); start >= 0;) {
    const closing = source.indexOf('-->', start + 4);
    const end = closing < 0 ? source.length : closing + 3;
    maskRange(characters, start, end);
    start = source.indexOf('<!--', end);
  }

  let activeFence = null;
  let activeIndentedCode = false;
  let paragraphOpen = false;
  for (const line of sourceLines(characters.join(''))) {
    const containerContent = line.content.replace(
      /^(?: {0,3}>[ \t]?)+/u,
      '',
    );
    if (activeFence) {
      maskRange(characters, line.start, line.end);
      const closing = containerContent.match(/^ {0,3}(`+|~+)[ \t]*$/u);
      if (
        closing
        && closing[1][0] === activeFence.marker
        && closing[1].length >= activeFence.length
      ) {
        activeFence = null;
      }
      continue;
    }

    const blank = /^[\t ]*$/u.test(containerContent);
    const indentation = indentationColumns(containerContent);
    if (activeIndentedCode) {
      if (blank || indentation >= 4) {
        maskRange(characters, line.start, line.end);
        continue;
      }
      activeIndentedCode = false;
    }

    const opening = containerContent.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (opening && !(opening[1][0] === '`' && opening[2].includes('`'))) {
      activeFence = {
        length: opening[1].length,
        marker: opening[1][0],
      };
      maskRange(characters, line.start, line.end);
      paragraphOpen = false;
      continue;
    }

    if (blank) {
      paragraphOpen = false;
      continue;
    }

    if (indentation >= 4 && !paragraphOpen) {
      activeIndentedCode = true;
      maskRange(characters, line.start, line.end);
      continue;
    }

    const leaf = containerContent.slice(indentationCharacterCount(
      containerContent,
      Math.min(indentation, 3),
    ));
    if (
      /^#{1,6}(?:[ \t]+|$)/u.test(leaf)
      || /^(?:=+|-+)[ \t]*$/u.test(leaf)
      || /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/u.test(leaf)
    ) {
      paragraphOpen = false;
    } else {
      paragraphOpen = true;
    }
  }

  return characters.join('');
}

function indentationColumns(value) {
  let columns = 0;
  for (const character of value) {
    if (character === ' ') {
      columns += 1;
    } else if (character === '\t') {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
  }
  return columns;
}

function indentationCharacterCount(value, maximumColumns) {
  let columns = 0;
  let index = 0;
  while (index < value.length && columns < maximumColumns) {
    if (value[index] === ' ') {
      columns += 1;
    } else if (value[index] === '\t') {
      columns += 4 - (columns % 4);
    } else {
      break;
    }
    index += 1;
  }
  return index;
}

function maskNonLinkMarkdown(source) {
  const characters = maskMarkdownBlocks(source).split('');
  const masked = characters.join('');

  for (let index = 0; index < masked.length;) {
    if (masked[index] !== '`') {
      index += 1;
      continue;
    }

    let openingEnd = index + 1;
    while (masked[openingEnd] === '`') {
      openingEnd += 1;
    }
    const delimiterLength = openingEnd - index;
    let cursor = openingEnd;
    let closingEnd = -1;

    while (cursor < masked.length) {
      const nextTick = masked.indexOf('`', cursor);
      if (nextTick < 0) {
        break;
      }
      let runEnd = nextTick + 1;
      while (masked[runEnd] === '`') {
        runEnd += 1;
      }
      if (runEnd - nextTick === delimiterLength) {
        closingEnd = runEnd;
        break;
      }
      cursor = runEnd;
    }

    if (closingEnd < 0) {
      index = openingEnd;
      continue;
    }
    maskRange(characters, index, closingEnd);
    index = closingEnd;
  }

  return characters.join('');
}

function lineStartOffsets(source) {
  const offsets = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) {
      offsets.push(index + 1);
    }
  }
  return offsets;
}

function lineNumberAt(offsets, index) {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (offsets[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function isEscaped(source, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function decodeHtmlEntities(value) {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|amp|apos|gt|lt|quot);/giu,
    (entity, decimal, hexadecimal) => {
      if (decimal) {
        return String.fromCodePoint(Number.parseInt(decimal, 10));
      }
      if (hexadecimal) {
        return String.fromCodePoint(Number.parseInt(hexadecimal, 16));
      }
      return {
        '&amp;': '&',
        '&apos;': "'",
        '&gt;': '>',
        '&lt;': '<',
        '&quot;': '"',
      }[entity.toLocaleLowerCase('en-US')] ?? entity;
    },
  );
}

function unescapeMarkdown(value) {
  return decodeHtmlEntities(
    value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/gu, '$1'),
  );
}

function normalizedMarkdownTarget(rawTarget) {
  return unescapeMarkdown(rawTarget.trim());
}

function findClosingBracket(source, openingIndex) {
  let depth = 0;
  for (let index = openingIndex; index < source.length; index += 1) {
    if (isEscaped(source, index)) {
      continue;
    }
    if (source[index] === '[') {
      depth += 1;
    } else if (source[index] === ']') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

function skipMarkdownWhitespace(source, start) {
  let index = start;
  while (/[\t\n\r ]/u.test(source[index] ?? '')) {
    index += 1;
  }
  return index;
}

function parseLinkTitleAndClose(source, start) {
  let index = skipMarkdownWhitespace(source, start);
  if (source[index] === ')') {
    return index;
  }

  const opener = source[index];
  const closer = opener === '(' ? ')' : opener;
  if (!['"', "'", '('].includes(opener)) {
    return -1;
  }
  index += 1;

  for (; index < source.length; index += 1) {
    if (source[index] === '\n' && source[index + 1] === '\n') {
      return -1;
    }
    if (source[index] === closer && !isEscaped(source, index)) {
      const closingParenthesis = skipMarkdownWhitespace(source, index + 1);
      return source[closingParenthesis] === ')' ? closingParenthesis : -1;
    }
  }
  return -1;
}

function parseInlineDestination(source, openingParenthesis) {
  let index = skipMarkdownWhitespace(source, openingParenthesis + 1);
  let target = '';
  let targetEnd = index;
  let targetStart = index;

  if (source[index] === '<') {
    targetStart = index + 1;
    index += 1;
    let foundClosingBracket = false;
    for (; index < source.length; index += 1) {
      if (source[index] === '\n' || source[index] === '\r') {
        return null;
      }
      if (source[index] === '>' && !isEscaped(source, index)) {
        targetEnd = index;
        target = source.slice(targetStart, index);
        index += 1;
        foundClosingBracket = true;
        break;
      }
    }
    if (!foundClosingBracket) {
      return null;
    }
  } else {
    targetStart = index;
    let parenthesisDepth = 0;

    for (; index < source.length; index += 1) {
      const character = source[index];
      if (isEscaped(source, index)) {
        continue;
      }
      if (character === '(') {
        parenthesisDepth += 1;
        continue;
      }
      if (character === ')') {
        if (parenthesisDepth === 0) {
          targetEnd = index;
          target = source.slice(targetStart, index);
          return {
            closingIndex: index,
            target,
            targetEnd,
            targetStart,
          };
        }
        parenthesisDepth -= 1;
        continue;
      }
      if (/[\t\n\r ]/u.test(character) && parenthesisDepth === 0) {
        targetEnd = index;
        target = source.slice(targetStart, index);
        break;
      }
      if (character === '<') {
        return null;
      }
    }
  }

  const closingIndex = parseLinkTitleAndClose(source, index);
  if (closingIndex < 0) {
    return null;
  }
  return {
    closingIndex,
    target,
    targetEnd,
    targetStart,
  };
}

function parseReferenceDestination(source, start, end) {
  let index = start;
  while (index < end && /[\t ]/u.test(source[index])) {
    index += 1;
  }

  if (source[index] === '<') {
    const targetStart = index + 1;
    for (index += 1; index < end; index += 1) {
      if (source[index] === '>' && !isEscaped(source, index)) {
        return {
          target: source.slice(targetStart, index),
          targetEnd: index,
          targetStart,
        };
      }
    }
    return null;
  }

  const targetStart = index;
  let parenthesisDepth = 0;
  for (; index < end; index += 1) {
    const character = source[index];
    if (isEscaped(source, index)) {
      continue;
    }
    if (character === '(') {
      parenthesisDepth += 1;
    } else if (character === ')' && parenthesisDepth > 0) {
      parenthesisDepth -= 1;
    } else if (/[\t ]/u.test(character) && parenthesisDepth === 0) {
      break;
    }
  }
  if (index === targetStart) {
    return null;
  }
  return {
    target: source.slice(targetStart, index),
    targetEnd: index,
    targetStart,
  };
}

function findHtmlTagEnd(source, start, allowNewlines = false) {
  let quote = '';
  for (let index = start + 1; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return index;
    } else if (!allowNewlines && (character === '\n' || character === '\r')) {
      return -1;
    }
  }
  return -1;
}

function extractLinks(source, relativePath) {
  const masked = maskNonLinkMarkdown(source);
  const lineOffsets = lineStartOffsets(masked);
  const links = [];
  const seenRanges = new Set();
  const addLink = (rawTarget, index, targetStart, targetEnd) => {
    if (rawTarget === null || rawTarget === undefined) {
      return;
    }
    const target = normalizedMarkdownTarget(rawTarget);
    const line = lineNumberAt(lineOffsets, index);
    const key = `${targetStart}:${targetEnd}`;
    if (!seenRanges.has(key)) {
      seenRanges.add(key);
      links.push({
        file: relativePath,
        line,
        target,
        targetEnd,
        targetStart,
      });
    }
  };

  for (let index = 0; index < masked.length; index += 1) {
    const openingBracket = masked[index] === '!'
      && masked[index + 1] === '['
      && !isEscaped(masked, index)
      ? index + 1
      : index;
    if (masked[openingBracket] !== '[' || isEscaped(masked, openingBracket)) {
      continue;
    }
    const closingBracket = findClosingBracket(masked, openingBracket);
    if (closingBracket < 0 || masked[closingBracket + 1] !== '(') {
      continue;
    }
    const parsed = parseInlineDestination(masked, closingBracket + 1);
    if (parsed) {
      addLink(
        parsed.target,
        index,
        parsed.targetStart,
        parsed.targetEnd,
      );
    }
  }

  const lines = sourceLines(masked);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const indentation = line.content.match(/^ {0,3}/u)?.[0].length ?? 0;
    const openingBracket = line.start + indentation;
    if (masked[openingBracket] !== '[') {
      continue;
    }
    const closingBracket = findClosingBracket(masked, openingBracket);
    if (
      closingBracket < 0
      || closingBracket >= line.contentEnd
      || masked[closingBracket + 1] !== ':'
    ) {
      continue;
    }
    let destinationStart = closingBracket + 2;
    let destinationEnd = line.contentEnd;
    if (
      /^[\t ]*$/u.test(masked.slice(destinationStart, destinationEnd))
      && lines[lineIndex + 1]
    ) {
      const continuation = lines[lineIndex + 1];
      const continuationIndent = continuation.content.match(/^ {0,3}/u)?.[0].length ?? 0;
      destinationStart = continuation.start + continuationIndent;
      destinationEnd = continuation.contentEnd;
    }
    const parsed = parseReferenceDestination(
      masked,
      destinationStart,
      destinationEnd,
    );
    if (parsed) {
      addLink(
        parsed.target,
        openingBracket,
        parsed.targetStart,
        parsed.targetEnd,
      );
    }
  }

  for (let index = masked.indexOf('<'); index >= 0;) {
    const isHtmlTag = /^<(?:a|area|img|source)\b/iu.test(masked.slice(index));
    const isAutolink = (
      /^<[a-z][a-z\d+.-]{0,31}:/iu.test(masked.slice(index))
      || /^<[\w.!#$%&'*+/=?^`{|}~-]+@/u.test(masked.slice(index))
    );
    if (!isHtmlTag && !isAutolink) {
      index = masked.indexOf('<', index + 1);
      continue;
    }

    const tagEnd = findHtmlTagEnd(masked, index, isHtmlTag);
    if (tagEnd < 0) {
      index = masked.indexOf('<', index + 1);
      continue;
    }

    const tag = masked.slice(index, tagEnd + 1);
    const autolink = tag.match(
      /^<([a-z][a-z\d+.-]{0,31}:[^\s<>]*)>$/iu,
    );
    if (autolink) {
      addLink(autolink[1], index, index + 1, tagEnd);
    } else if (/^<[\w.!#$%&'*+/=?^`{|}~-]+@[^<>\s]+>$/u.test(tag)) {
      addLink(`mailto:${tag.slice(1, -1)}`, index, index + 1, tagEnd);
    } else if (isHtmlTag) {
      const attributes = tag.matchAll(
        /(?:^|[\t\n\r ])(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gimu,
      );
      for (const match of attributes) {
        const rawTarget = match[1] ?? match[2] ?? match[3];
        const attributeStart = index + (match.index ?? 0);
        const valueOffset = match[0].lastIndexOf(rawTarget);
        const targetStart = attributeStart + valueOffset;
        addLink(
          rawTarget,
          attributeStart,
          targetStart,
          targetStart + rawTarget.length,
        );
      }
    }
    index = masked.indexOf('<', tagEnd + 1);
  }

  for (const match of masked.matchAll(/\bhttps?:\/\//giu)) {
    const start = match.index ?? 0;
    let index = start;
    let parenthesisDepth = 0;
    while (index < masked.length) {
      const character = masked[index];
      if (/[\s<>"'`]/u.test(character)) {
        break;
      }
      if (character === '(') {
        parenthesisDepth += 1;
      } else if (character === ')') {
        if (parenthesisDepth === 0) {
          break;
        }
        parenthesisDepth -= 1;
      }
      index += 1;
    }
    const target = masked
      .slice(start, index)
      .replace(/[\].,;:!?]+$/u, '');
    addLink(target, start, start, start + target.length);
  }

  return links
    .sort((left, right) => (
      left.targetStart - right.targetStart
      || left.targetEnd - right.targetEnd
    ))
    .map(({
      targetEnd: _targetEnd,
      targetStart: _targetStart,
      ...link
    }) => link);
}

function decoded(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function localTargetParts(target) {
  const hashIndex = target.indexOf('#');
  const queryIndex = target.indexOf('?');
  const indexes = [hashIndex, queryIndex].filter((index) => index >= 0);
  const pathEnd = indexes.length > 0 ? Math.min(...indexes) : target.length;
  const fragment = hashIndex >= 0
    ? target.slice(hashIndex + 1, queryIndex > hashIndex ? queryIndex : undefined)
    : '';

  return {
    fragment: decoded(fragment),
    path: decoded(target.slice(0, pathEnd)),
  };
}

function githubHeadingSlug(rawHeading) {
  return decodeHtmlEntities(rawHeading)
    .normalize('NFKC')
    .replace(/<[^>]+>/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/[`*_~]/gu, '')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s+/gu, '-');
}

function allocateHeadingSlugs(headings) {
  const anchors = new Set();
  const nextSuffixes = new Map();

  for (const heading of headings) {
    const baseSlug = githubHeadingSlug(heading);
    if (!baseSlug) {
      continue;
    }

    let slug = baseSlug;
    if (anchors.has(slug)) {
      let suffix = nextSuffixes.get(baseSlug) ?? 1;
      do {
        slug = `${baseSlug}-${suffix}`;
        suffix += 1;
      } while (anchors.has(slug));
      nextSuffixes.set(baseSlug, suffix);
    } else {
      nextSuffixes.set(baseSlug, 1);
    }
    anchors.add(slug);
  }

  return anchors;
}

function markdownAnchorsFromSource(rawSource) {
  const source = maskMarkdownBlocks(rawSource)
    .replace(/`+([^`\r\n]*)`+/gu, '$1');
  const headings = [];
  const indexedHeadings = [];

  for (const match of source.matchAll(/^ {0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gmu)) {
    indexedHeadings.push({ index: match.index ?? 0, text: match[1] });
  }

  const lines = sourceLines(source);
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (
      lines[index].content.trim()
      && /^ {0,3}(?:=+|-+)[ \t]*$/u.test(lines[index + 1].content)
    ) {
      indexedHeadings.push({
        index: lines[index].start,
        text: lines[index].content.trim(),
      });
    }
  }

  indexedHeadings.sort((left, right) => left.index - right.index);
  headings.push(...indexedHeadings.map(({ text }) => text));
  const anchors = allocateHeadingSlugs(headings);

  for (const match of source.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/giu)) {
    anchors.add(decoded(match[1]));
  }
  return anchors;
}

const anchorCache = new Map();

function markdownAnchors(absolutePath) {
  if (!anchorCache.has(absolutePath)) {
    anchorCache.set(
      absolutePath,
      markdownAnchorsFromSource(readFileSync(absolutePath, 'utf8')),
    );
  }
  return anchorCache.get(absolutePath);
}

function pathInsideRepository(absolutePath, root = repositoryRoot) {
  const relativePath = relative(root, absolutePath);
  return relativePath === ''
    || (
      !isAbsolute(relativePath)
      &&
      relativePath !== '..'
      && !relativePath.startsWith(`..\\`)
      && !relativePath.startsWith('../')
    );
}

function localIssue(link, message, kind = 'local') {
  return {
    ...link,
    kind,
    message,
    severity: 'error',
  };
}

function validateLocalLink(link, root = repositoryRoot) {
  const rootRealPath = realpathSync(root);
  const { fragment, path } = localTargetParts(link.target);
  const sourcePath = resolve(rootRealPath, link.file);
  if (!existsSync(sourcePath)) {
    return localIssue(link, 'source document does not exist');
  }

  const sourceRealPath = realpathSync(sourcePath);
  if (!pathInsideRepository(sourceRealPath, rootRealPath)) {
    return localIssue(link, 'source document escapes the repository');
  }

  const targetPath = path
    ? resolve(dirname(sourcePath), path)
    : sourcePath;
  if (!pathInsideRepository(targetPath, rootRealPath)) {
    return localIssue(link, 'target escapes the repository');
  }
  if (!existsSync(targetPath)) {
    return localIssue(link, 'target does not exist');
  }

  const targetRealPath = realpathSync(targetPath);
  if (!pathInsideRepository(targetRealPath, rootRealPath)) {
    return localIssue(link, 'target escapes the repository');
  }

  if (
    fragment
    && !statSync(targetRealPath).isDirectory()
    && extname(targetPath).toLocaleLowerCase('en-US') === '.md'
    && !markdownAnchors(targetRealPath).has(fragment)
  ) {
    return localIssue(link, `Markdown anchor not found: #${fragment}`, 'anchor');
  }

  return null;
}

function isExternalUrl(target) {
  return /^https?:\/\//iu.test(target);
}

function shouldSkipTarget(target) {
  return (
    target.startsWith('/')
    || target.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/iu.test(target)
  );
}

function redactedUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const queryMarker = url.search ? '?<redacted>' : '';
    return `${url.protocol}//${url.host}${url.pathname}${queryMarker}`;
  } catch {
    return '<invalid URL>';
  }
}

function redactedLocalTarget(target) {
  const queryIndex = target.indexOf('?');
  if (queryIndex < 0) {
    return target;
  }
  const fragmentIndex = target.indexOf('#', queryIndex);
  return `${target.slice(0, queryIndex)}?<redacted>${
    fragmentIndex >= 0 ? target.slice(fragmentIndex) : ''
  }`;
}

function redactedErrorMessage(error) {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message
    .replace(/https?:\/\/[^\s]+/giu, (url) => redactedUrl(url))
    .replace(
      /\b(api[_-]?key|password|secret|token)=([^\s&]+)/giu,
      '$1=<redacted>',
    );
}

function parseIpv4(address) {
  const octets = address.split('.');
  if (
    octets.length !== 4
    || octets.some((octet) => !/^(?:0|[1-9]\d{0,2})$/u.test(octet))
  ) {
    return null;
  }
  const numbers = octets.map(Number);
  if (numbers.some((octet) => octet > 255)) {
    return null;
  }
  return numbers.reduce((value, octet) => ((value * 256) + octet) >>> 0, 0);
}

function ipv4InCidr(addressValue, baseAddress, prefixLength) {
  const baseValue = parseIpv4(baseAddress);
  const mask = prefixLength === 0
    ? 0
    : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (addressValue & mask) === (baseValue & mask);
}

const specialIpv4Ranges = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function parseIpv6(address) {
  let normalized = address.toLocaleLowerCase('en-US');
  const ipv4Separator = normalized.lastIndexOf(':');
  if (normalized.includes('.') && ipv4Separator >= 0) {
    const ipv4Value = parseIpv4(normalized.slice(ipv4Separator + 1));
    if (ipv4Value === null) {
      return null;
    }
    normalized = `${normalized.slice(0, ipv4Separator)}:${
      (ipv4Value >>> 16).toString(16)
    }:${(ipv4Value & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (
    missing < 0
    || (halves.length === 1 && missing !== 0)
    || (halves.length === 2 && missing < 1)
  ) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (
    groups.length !== 8
    || groups.some((group) => !/^[\da-f]{1,4}$/u.test(group))
  ) {
    return null;
  }
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  );
}

function ipv6InCidr(addressValue, baseAddress, prefixLength) {
  const baseValue = parseIpv6(baseAddress);
  const shift = BigInt(128 - prefixLength);
  return (addressValue >> shift) === (baseValue >> shift);
}

const specialIpv6Ranges = [
  ['::', 96],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
];

function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) {
    const value = parseIpv4(address);
    return value !== null && !specialIpv4Ranges.some(
      ([baseAddress, prefixLength]) => ipv4InCidr(value, baseAddress, prefixLength),
    );
  }
  if (version === 6) {
    const value = parseIpv6(address);
    return value !== null
      && ipv6InCidr(value, '2000::', 3)
      && !specialIpv6Ranges.some(
        ([baseAddress, prefixLength]) => ipv6InCidr(value, baseAddress, prefixLength),
      );
  }
  return false;
}

function policyError(message, code = '') {
  const error = new Error(message);
  if (code) {
    error.code = code;
  }
  return error;
}

function normalizedHostname(url) {
  return url.hostname
    .replace(/^\[(.*)\]$/u, '$1')
    .replace(/\.$/u, '')
    .toLocaleLowerCase('en-US');
}

function assertPublicHttpUrl(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw policyError('unsupported-protocol');
  }
  if (url.username || url.password) {
    throw policyError('embedded-credentials');
  }

  const hostname = normalizedHostname(url);
  if (
    !hostname
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
  ) {
    throw policyError('private-host');
  }
  if (isIP(hostname) && !isPublicIp(hostname)) {
    throw policyError('private-host');
  }
  return hostname;
}

function createPinnedLookup(resolver = lookup) {
  return (hostname, rawOptions, callback) => {
    const options = typeof rawOptions === 'number'
      ? { family: rawOptions }
      : (rawOptions ?? {});

    Promise.resolve(resolver(hostname, { all: true, verbatim: true }))
      .then((resolvedAddresses) => {
        const addresses = Array.isArray(resolvedAddresses)
          ? resolvedAddresses
          : [resolvedAddresses];
        if (
          addresses.length === 0
          || addresses.some(({ address, family }) => (
            isIP(address) !== Number(family)
            || !isPublicIp(address)
          ))
        ) {
          callback(policyError('private-host', 'ERR_NON_PUBLIC_ADDRESS'));
          return;
        }

        const requestedFamily = Number(options.family) || 0;
        const candidates = addresses
          .filter(({ family }) => !requestedFamily || family === requestedFamily)
          .map(({ address, family }) => ({ address, family: Number(family) }));
        if (candidates.length === 0) {
          callback(policyError('name resolution returned no usable address', 'ENOTFOUND'));
          return;
        }

        if (options.all) {
          callback(null, candidates);
        } else {
          callback(null, candidates[0].address, candidates[0].family);
        }
      })
      .catch((error) => {
        callback(error instanceof Error ? error : policyError('name resolution failed'));
      });
  };
}

function requestHttpStatus(
  url,
  requestTimeoutMs,
  method,
  {
    requestImplementation,
    resolver = lookup,
  } = {},
) {
  const hostname = assertPublicHttpUrl(url);
  const directIp = isIP(hostname) !== 0;
  const transportRequest = requestImplementation
    ?? (url.protocol === 'https:' ? httpsRequest : httpRequest);

  return new Promise((resolveRequest, rejectRequest) => {
    let request;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      callback(value);
    };
    const timeout = setTimeout(() => {
      const error = policyError('request-timeout');
      error.name = 'TimeoutError';
      if (request) {
        request.destroy(error);
      } else {
        finish(rejectRequest, error);
      }
    }, requestTimeoutMs);

    try {
      request = transportRequest(
        {
          agent: false,
          headers: externalRequestHeaders,
          hostname,
          lookup: directIp ? undefined : createPinnedLookup(resolver),
          method,
          path: `${url.pathname}${url.search}`,
          port: url.port || undefined,
          protocol: url.protocol,
          ...(url.protocol === 'https:' && !directIp ? { servername: hostname } : {}),
        },
        (response) => {
          const location = Array.isArray(response.headers.location)
            ? response.headers.location[0]
            : response.headers.location;
          if (response.statusCode === undefined) {
            finish(rejectRequest, policyError('request-failed'));
            response.destroy();
            return;
          }
          const result = {
            location,
            status: response.statusCode,
          };
          finish(resolveRequest, result);
          response.resume();
          response.destroy();
        },
      );
      request.once('error', (error) => {
        finish(rejectRequest, error);
      });
      request.end();
    } catch (error) {
      finish(rejectRequest, error);
    }
  });
}

async function fetchWithRedirects(
  rawUrl,
  requestTimeoutMs,
  method,
  dependencies,
) {
  let currentUrl = new URL(rawUrl);
  currentUrl.hash = '';

  for (let redirects = 0; redirects <= 5; redirects += 1) {
    assertPublicHttpUrl(currentUrl);
    const response = await requestHttpStatus(
      currentUrl,
      requestTimeoutMs,
      method,
      dependencies,
    );

    if (response.status < 300 || response.status >= 400) {
      return response.status;
    }
    if (!response.location) {
      return response.status;
    }
    if (redirects === 5) {
      throw policyError('too-many-redirects');
    }
    currentUrl = new URL(response.location, currentUrl);
    currentUrl.hash = '';
  }

  throw policyError('too-many-redirects');
}

function transientStatus(status) {
  return status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function requestFailureReason(error) {
  if (!(error instanceof Error)) {
    return 'request-failed';
  }
  if (permanentFailureReasons.has(error.message) || error.message === 'request-timeout') {
    return error.message;
  }

  const cause = 'cause' in error ? error.cause : undefined;
  if (
    cause instanceof Error
    && (
      permanentFailureReasons.has(cause.message)
      || cause.message === 'request-timeout'
    )
  ) {
    return cause.message;
  }
  const directCode = 'code' in error && typeof error.code === 'string'
    ? error.code
    : '';
  const causeCode = (
    cause
    && typeof cause === 'object'
    && 'code' in cause
    && typeof cause.code === 'string'
  )
    ? cause.code
    : '';
  const code = directCode || causeCode;

  return /^[A-Z][A-Z0-9_]*$/u.test(code)
    ? code
    : (error.name === 'TimeoutError' ? 'request-timeout' : 'request-failed');
}

function permanentRequestFailure(reason) {
  return permanentFailureReasons.has(reason);
}

async function checkExternalUrl(rawUrl, options) {
  let lastStatus = 0;
  let lastErrorCode = '';
  const requester = options.requester ?? fetchWithRedirects;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      let status = await requester(rawUrl, options.requestTimeoutMs, 'HEAD');
      if (
        (
          status >= 400
          && status < 500
          && ![408, 425, 429].includes(status)
        )
        || status === 501
      ) {
        status = await requester(rawUrl, options.requestTimeoutMs, 'GET');
      }
      lastStatus = status;

      if (status >= 200 && status < 400) {
        return { outcome: 'passed', status };
      }
      if ([401, 403, 407].includes(status)) {
        return { outcome: 'warning', reason: 'access restricted', status };
      }
      if (!transientStatus(status) || attempt === options.retries) {
        return {
          outcome: transientStatus(status) ? 'warning' : 'failed',
          reason: transientStatus(status) ? 'transient HTTP response' : 'broken HTTP response',
          status,
        };
      }
    } catch (error) {
      lastErrorCode = requestFailureReason(error);
      if (lastErrorCode === 'private-host') {
        return { outcome: 'warning', reason: 'non-public URL was not requested' };
      }
      if (permanentRequestFailure(lastErrorCode)) {
        return { outcome: 'failed', reason: lastErrorCode };
      }
      if (attempt === options.retries) {
        return { outcome: 'warning', reason: lastErrorCode };
      }
    }

    await delay(250 * (attempt + 1));
  }

  return {
    outcome: 'warning',
    reason: lastErrorCode || 'transient HTTP response',
    status: lastStatus || undefined,
  };
}

async function concurrentMap(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(concurrency, items.length) },
      () => worker(),
    ),
  );
  return results;
}

function reportIssue(issue) {
  const prefix = issue.severity === 'error' ? 'FAIL' : 'WARN';
  const target = issue.kind === 'external'
    ? redactedUrl(issue.target)
    : redactedLocalTarget(issue.target);
  const status = issue.status ? ` (HTTP ${issue.status})` : '';
  process.stdout.write(
    `${prefix}: ${issue.file}:${issue.line} ${target} - ${issue.message}${status}\n`,
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = trackedMarkdownFiles();
  const links = files.flatMap((file) => (
    extractLinks(readFileSync(resolve(repositoryRoot, file), 'utf8'), file)
  ));
  const issues = [];
  let localChecked = 0;
  let skipped = 0;
  const externalReferences = new Map();

  for (const link of links) {
    if (isExternalUrl(link.target)) {
      let normalizedUrl;
      try {
        const parsed = new URL(link.target);
        parsed.hash = '';
        normalizedUrl = parsed.toString();
      } catch {
        issues.push({
          ...link,
          kind: 'external',
          message: 'invalid HTTP URL',
          severity: 'error',
        });
        continue;
      }

      const references = externalReferences.get(normalizedUrl) ?? [];
      references.push(link);
      externalReferences.set(normalizedUrl, references);
      continue;
    }

    if (shouldSkipTarget(link.target)) {
      skipped += 1;
      continue;
    }

    localChecked += 1;
    const issue = validateLocalLink(link);
    if (issue) {
      issues.push(issue);
    }
  }

  const externalEntries = [...externalReferences.entries()];
  let externalResults = [];
  if (!options.localOnly) {
    externalResults = await concurrentMap(
      externalEntries,
      options.concurrency,
      async ([url, references]) => ({
        references,
        result: await checkExternalUrl(url, options),
        url,
      }),
    );

    for (const { references, result, url } of externalResults) {
      if (result.outcome === 'passed') {
        continue;
      }
      for (const reference of references) {
        issues.push({
          ...reference,
          kind: 'external',
          message: result.reason ?? result.outcome,
          severity: result.outcome === 'failed' ? 'error' : 'warning',
          status: result.status,
          target: url,
        });
      }
    }
  }

  const errors = issues.filter(({ severity }) => severity === 'error');
  const warnings = issues.filter(({ severity }) => severity === 'warning');
  for (const issue of issues) {
    reportIssue(issue);
  }

  const externalPassed = externalResults.filter(
    ({ result }) => result.outcome === 'passed',
  ).length;
  const externalFailed = externalResults.filter(
    ({ result }) => result.outcome === 'failed',
  ).length;
  const externalWarnings = externalResults.filter(
    ({ result }) => result.outcome === 'warning',
  ).length;
  const localFailures = errors.filter(
    ({ kind }) => kind === 'local' || kind === 'anchor',
  ).length;
  const summary = {
    errors: errors.length,
    external: {
      checked: externalResults.length,
      failed: externalFailed,
      passed: externalPassed,
      warnings: externalWarnings,
    },
    filesScanned: files.length,
    generatedAt: new Date().toISOString(),
    linksFound: links.length,
    local: {
      checked: localChecked,
      failed: localFailures,
      passed: localChecked - localFailures,
    },
    mode: options.localOnly ? 'local-only' : 'local-and-external',
    skipped,
    uniqueExternalUrls: externalEntries.length,
    warnings: warnings.length,
  };

  process.stdout.write('\nDocumentation link audit\n');
  process.stdout.write(`Maintained Markdown files: ${summary.filesScanned}\n`);
  process.stdout.write(`Links found: ${summary.linksFound}\n`);
  process.stdout.write(
    `Local targets: ${summary.local.passed} passed, ${summary.local.failed} failed\n`,
  );
  if (options.localOnly) {
    process.stdout.write(
      `External URLs: ${summary.uniqueExternalUrls} discovered, network checks skipped\n`,
    );
  } else {
    process.stdout.write(
      `External URLs: ${summary.external.passed} passed, `
      + `${summary.external.failed} failed, ${summary.external.warnings} warnings\n`,
    );
  }
  process.stdout.write(`Skipped routes and non-HTTP schemes: ${summary.skipped}\n`);
  process.stdout.write(`Result: ${summary.errors === 0 ? 'PASS' : 'FAIL'}\n`);

  if (options.jsonReport) {
    const reportPath = resolve(repositoryRoot, options.jsonReport);
    const sanitizedIssues = issues.map((issue) => ({
      file: issue.file,
      kind: issue.kind,
      line: issue.line,
      message: issue.message,
      severity: issue.severity,
      ...(issue.status ? { status: issue.status } : {}),
      target: issue.kind === 'external'
        ? redactedUrl(issue.target)
        : redactedLocalTarget(issue.target),
    }));
    writeFileSync(
      reportPath,
      `${JSON.stringify({ ...summary, issues: sanitizedIssues }, null, 2)}\n`,
      'utf8',
    );
  }

  process.exitCode = summary.errors === 0 ? 0 : 1;
  return summary;
}

const isCliExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isCliExecution) {
  main().catch((error) => {
    process.stderr.write(
      `Documentation link audit failed to run: ${redactedErrorMessage(error)}\n`,
    );
    process.exitCode = 1;
  });
}

export {
  allocateHeadingSlugs,
  assertPublicHttpUrl,
  checkExternalUrl,
  createPinnedLookup,
  extractLinks,
  fetchWithRedirects,
  githubHeadingSlug,
  isPublicIp,
  main,
  markdownAnchorsFromSource,
  maskMarkdownBlocks,
  maskNonLinkMarkdown,
  parseArguments,
  pathInsideRepository,
  permanentRequestFailure,
  redactedLocalTarget,
  redactedErrorMessage,
  redactedUrl,
  requestFailureReason,
  requestHttpStatus,
  validateLocalLink,
};
