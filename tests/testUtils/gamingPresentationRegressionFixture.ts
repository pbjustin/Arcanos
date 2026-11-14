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

// Exact player-facing text from the isolated PR #1599 validation.
export const isolatedColonisationAnswer = [
  'Some selected source material was only partially extracted. This answer is limited to the intact passages available for review.',
  'To start system colonisation in **Elite Dangerous**, use the **System Colonisation Contact** at a starport to select an unpopulated system within 15 light-years, choose your initial starport or outpost, and pay the registration fee. Your claim lasts 24 hours and is launched through the **System Colonisation Suite** in your ship, making you the System Architect and starting a countdown to the arrival of a System Colonisation Ship that acts as a temporary construction hub. The supplied excerpts cover registration and launch, not the full construction process or every prerequisite. [1]',
  '**Source:** [Frontier Developments, System Colonisation Guide](https://www.elitedangerous.com/news/system-colonisation-guide) [1]',
  "I can't verify live game state here.",
].join('\n\n');

// Exact answer returned by the replacement-key isolated validation on PR #1599.
export const numberedLiveColonisationAnswer = [
  'Some selected source material was only partially extracted. This answer is limited to the intact passages available for review.',
  'To start system colonisation in **Elite Dangerous**:',
  '1. Use the **System Colonisation Contact** at a starport to select an unpopulated system within 15 ly.\n2. Choose the type of initial starport or outpost.\n3. Pay the registration fee.',
  'This gives you a 24-hour claim window. Launch the process through the **System Colonisation Suite** (included in all ships), which establishes you as the System Architect and triggers a countdown for the arrival of a System Colonisation Ship that acts as a temporary construction hub. The supplied excerpts cover claiming a system and initiating colonisation, not a complete prerequisites list or construction walkthrough. [1]',
  '[1] [Elite Dangerous — System Colonisation Guide](https://www.elitedangerous.com/news/system-colonisation-guide)',
  'This guidance follows the supplied official guide excerpts; current live-game changes have not been checked.',
  "I can't verify live game state here.",
].join('\n\n');
