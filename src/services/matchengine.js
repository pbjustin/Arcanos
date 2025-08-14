module.exports.simulateMatch = async function(match, rosters, winProbModifier = 0) {
    const { wrestler1, wrestler2, matchType, kayfabeMode = false } = match;

    const w1 = rosters.find(r => r.name === wrestler1);
    const w2 = rosters.find(r => r.name === wrestler2);

    if (!w1 || !w2) {
        throw new Error("One or both wrestlers not found in roster");
    }

    let w1Chance = w1.overall / (w1.overall + w2.overall);
    let w2Chance = 1 - w1Chance;

    w1Chance += winProbModifier;
    w2Chance -= winProbModifier;

    w1Chance = Math.max(0, Math.min(1, w1Chance));
    w2Chance = 1 - w1Chance;

    let interference = null;
    if (Math.random() < 0.1) {
        interference = rosters[Math.floor(Math.random() * rosters.length)].name;
        if (Math.random() > 0.5) {
            w1Chance += 0.15;
            w2Chance -= 0.15;
        } else {
            w1Chance -= 0.15;
            w2Chance += 0.15;
        }
        w1Chance = Math.max(0, Math.min(1, w1Chance));
        w2Chance = 1 - w1Chance;
    }

    const roll = Math.random();
    const winner = roll < w1Chance ? wrestler1 : wrestler2;
    const loser = winner === wrestler1 ? wrestler2 : wrestler1;

    const rating = (Math.random() * 4 + 1).toFixed(1);

    if (kayfabeMode) {
        return {
            match: `${wrestler1} vs ${wrestler2} (${matchType})`,
            result: `${winner} wins`,
            via: "Pinfall",
            interference,
            rating
        };
    } else {
        return {
            match: `${wrestler1} vs ${wrestler2} (${matchType})`,
            winner,
            loser,
            probability: {
                [wrestler1]: w1Chance.toFixed(2),
                [wrestler2]: w2Chance.toFixed(2)
            },
            interference,
            rating
        };
    }
};
