/** The existing match algorithm, separated from roster storage and HRC transport. */
export function simulateBackstageMatchCore(
  match: { wrestler1: string; wrestler2: string; matchType: string; kayfabeMode?: boolean },
  activeRoster: readonly { name: string; overall: number }[],
  winProbModifier = 0,
  random: () => number = Math.random,
) {
  const { wrestler1, wrestler2, matchType, kayfabeMode = false } = match;
  const w1 = activeRoster.find(r => r.name === wrestler1);
  const w2 = activeRoster.find(r => r.name === wrestler2);
  if (!w1 || !w2) throw new Error('One or both wrestlers not found in roster');
  const totalOverall = w1.overall + w2.overall;
  let w1Chance = totalOverall === 0 ? 0.5 : w1.overall / totalOverall;
  let w2Chance = 1 - w1Chance;
  w1Chance = Math.min(Math.max(w1Chance + winProbModifier, 0), 1);
  w2Chance = 1 - w1Chance;
  let interference: string | null = null;
  const interferenceCandidates = activeRoster.filter(
    wrestler => wrestler.name !== wrestler1 && wrestler.name !== wrestler2
  );
  if (random() < 0.1 && interferenceCandidates.length > 0) {
    interference = interferenceCandidates[Math.floor(random() * interferenceCandidates.length)].name;
    if (random() > 0.5) w1Chance = Math.min(Math.max(w1Chance + 0.15, 0), 1);
    else w1Chance = Math.min(Math.max(w1Chance - 0.15, 0), 1);
    w2Chance = 1 - w1Chance;
  }
  const roll = random();
  const winner = roll < w1Chance ? wrestler1 : wrestler2;
  const loser = winner === wrestler1 ? wrestler2 : wrestler1;
  const rating = (random() * 4 + 1).toFixed(1);
  return kayfabeMode
    ? { match: `${wrestler1} vs ${wrestler2} (${matchType})`, result: `${winner} wins`,
      via: 'Pinfall', interference, rating }
    : { match: `${wrestler1} vs ${wrestler2} (${matchType})`, winner, loser,
      probability: { [wrestler1]: w1Chance.toFixed(2), [wrestler2]: w2Chance.toFixed(2) }, interference, rating };
}
