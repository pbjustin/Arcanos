/** License-safe invented article text. No publisher content is copied. */
export function gamingGenericScopeHtml(game: string, extra: string, title = `${game} beginner guide`): string {
  return `<html><head><title>${title}</title></head><body><header>Community notebook</header>
    <main><article><h1>${title}</h1><p>In ${game}, inspect your starting equipment before the first mission.
    Read the route marker, gather supplies, and return to the safe area when supplies run low.
    Practice one attack at a time, preserve enough stamina to dodge, and check the journal before leaving.
    Upgrade available equipment before entering the next area.</p><p>${extra}</p></article></main></body></html>`;
}
