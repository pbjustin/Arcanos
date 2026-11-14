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
