import { digest } from './tutor-package-core.mjs';

/** Map every source byte exactly once; labels never include private section titles. */
export function instructionSectionMap(instructions, outputStartByte, targetPrefix = 'teaching-core-section') {
  const starts = [0];
  for (const match of instructions.matchAll(/\r?\n[ \t]*\r?\n/gu)) {
    const next = match.index + match[0].length;
    if (next < instructions.length) starts.push(next);
  }
  if (starts.length > 512) throw new Error('TOO_MANY_INSTRUCTION_SECTIONS');
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? instructions.length;
    const bytes = Buffer.from(instructions.slice(start, end), 'utf8');
    const sourceStartByte = Buffer.byteLength(instructions.slice(0, start), 'utf8');
    const suffix = String(index + 1).padStart(3, '0');
    return { sourceId: `instruction-section-${suffix}`, targetId: `${targetPrefix}-${suffix}`,
      sourceStartByte, sourceEndByte: sourceStartByte + bytes.length,
      outputStartByte: outputStartByte + sourceStartByte,
      outputEndByte: outputStartByte + sourceStartByte + bytes.length, sha256: digest(bytes) };
  });
}

/** Pure, local transformations. The complete old/new section wording stays in the private result. */
export function transformInstructionSections(instructions, outputStartByte, transformations, targetPrefix) {
  let content = '';
  const bytes = Buffer.from(instructions, 'utf8');
  const sections = instructionSectionMap(instructions, 0, targetPrefix).map(section => {
    const sourceText = bytes.subarray(section.sourceStartByte, section.sourceEndByte).toString('utf8');
    let transformedText = sourceText;
    const applied = [];
    for (const transformation of transformations) {
      let count = 0;
      transformedText = transformedText.replace(transformation.pattern, () => {
        count += 1;
        return transformation.replacement;
      });
      if (count) applied.push({ id: transformation.id, count, reason: transformation.reason,
        intendedEffect: transformation.intendedEffect, oldAction: transformation.oldAction ?? null,
        mcpOperation: transformation.mcpOperation ?? null });
    }
    const start = outputStartByte + Buffer.byteLength(content, 'utf8');
    content += transformedText;
    return { ...section, outputStartByte: start, outputEndByte: outputStartByte + Buffer.byteLength(content, 'utf8'),
      outputSha256: digest(transformedText), disposition: applied.length ? 'TRANSFORMED' : 'PRESERVED',
      transformations: applied, sourceText, transformedText };
  });
  return { content, sections };
}
