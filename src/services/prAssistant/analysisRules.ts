export const DEAD_CODE_PATTERNS = {
  todo: /^\+.*(?:TODO|FIXME|XXX|HACK)/gim,
  debug: /^\+.*console\.(?:log|debug|warn|error)/gim,
  duplicate: /^\+.*(\w+.*){3,}/gim
} as const;

export const SIMPLIFICATION_PATTERNS = {
  functionAddition: /^\+.*(?:function|=>|\bconst\s+\w+\s*=)/gim,
  longFunction: /^\+.*(?:function|=>)[\s\S]*?(?=^[+-]|\n\n|$)/gim,
  complexity: /^\+.*(?:if|for|while|switch).*{[\s\S]*?(?:if|for|while|switch)/gim,
  largeString: (threshold: number) => new RegExp(`^\\+.*['"\`][^'"\`]{${threshold},}['"\`]`, 'gim'),
  magicNumbers: /^\+.*(?<![.\w])\d{3,}(?![.\w])/gim
} as const;

export const CHECK_THRESHOLDS = {
  maxDebugStatements: 3,
  maxComplexityPatterns: 2,
  maxMagicNumbers: 2,
  longFunctionLineCount: 50
} as const;
