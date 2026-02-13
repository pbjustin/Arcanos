export const HARD_TOKEN_CAP = 1200;

export function enforceTokenCap(requested?: number) {
  return Math.min(requested ?? HARD_TOKEN_CAP, HARD_TOKEN_CAP);
}
