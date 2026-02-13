export function detectDowngrade(
  requested: string,
  actual: string
) {
  return requested !== actual;
}
