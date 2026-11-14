export const colonisationRequest = 'Find a detailed guide explaining system colonisation in Elite Dangerous and how to get started, including prerequisites and the first concrete steps. Cite the guide sources.';

export const malformedColonisationCapabilityParagraph =
  "I can help with Explain the supported starting requirements and registration process., Provide concrete first steps using the supplied official guide., Explain the 24-hour claim and the initial role of the System Colonisation Ship., and Cite source [1] and distinguish supported mechanics from practical suggestions., but I can't Establish the complete prerequisite list or exact registration prices from the supplied excerpts., Provide detailed construction requirements or later-stage instructions., and Verify current live mechanics or platform availability. here.";

export const colonisationReasoningTasks = {
  response_mode: 'partial_refusal',
  achievable_subtasks: [
    'Explain the supported starting requirements and registration process.',
    'Provide concrete first steps using the supplied official guide.',
    'Explain the 24-hour claim and the initial role of the System Colonisation Ship.',
    'Cite source [1] and distinguish supported mechanics from practical suggestions.'
  ],
  blocked_subtasks: [
    'Establish the complete prerequisite list or exact registration prices from the supplied excerpts.',
    'Provide detailed construction requirements or later-stage instructions.',
    'Verify current live mechanics or platform availability.'
  ]
} as const;

// Exact player-facing text from the reconnected installed-plugin response.
export const installedColonisationAnswer = [
  "Some selected source material was only partially extracted. This answer is limited to the intact passages available for review.",
  "To start system colonisation in **Elite Dangerous**, open the **System Colonisation Contact** at a starport, select an unpopulated system within 15 ly, choose the initial station or outpost, pay the registration cost, and then launch the claim using your ship\u2019s **System Colonisation Suite**. This makes you the System Architect and starts a countdown to the arrival of the colonisation ship, which acts as the temporary construction hub. The supplied excerpts explain registration and launching a claim, but do not establish every prerequisite or the later construction procedure. [1]",
  "**Source:** [1] Frontier Developments, [System Colonisation Guide](https://www.elitedangerous.com/news/system-colonisation-guide).",
  "Exact prices, eligibility restrictions, construction materials, and deadlines beyond the initial claim window are not established here.",
  "I can't verify live game state here.",
].join('\n\n');
