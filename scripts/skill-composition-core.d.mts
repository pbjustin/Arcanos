export interface InstructionSection {
  sourceId: string;
  targetId: string;
  sourceStartByte: number;
  sourceEndByte: number;
  outputStartByte: number;
  outputEndByte: number;
  sha256: string;
}

export interface InstructionTransformation {
  id: string;
  pattern: RegExp;
  replacement: string;
  reason: string;
  intendedEffect: string;
  oldAction?: string;
  mcpOperation?: string;
}

export interface InstructionTransformationTrace {
  id: string;
  count: number;
  reason: string;
  intendedEffect: string;
  oldAction: string | null;
  mcpOperation: string | null;
}

export interface TransformedInstructionSection extends InstructionSection {
  outputSha256: string;
  disposition: 'TRANSFORMED' | 'PRESERVED';
  transformations: InstructionTransformationTrace[];
  sourceText: string;
  transformedText: string;
}

export function instructionSectionMap(instructions: string, outputStartByte: number,
  targetPrefix?: string): InstructionSection[];
export function transformInstructionSections(instructions: string, outputStartByte: number,
  transformations: readonly InstructionTransformation[], targetPrefix?: string): {
  content: string;
  sections: TransformedInstructionSection[];
};
