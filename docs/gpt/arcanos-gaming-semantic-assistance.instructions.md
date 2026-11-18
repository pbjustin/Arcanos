# Proposed Gaming semantic assistance instructions

Review this addendum with the complete private Gaming skill after the backend
supports the new schema. It changes the first query and how to present a
conversational result. Keep the released v2 rules for candidate acquisition,
currentness, recovery, authentication, and explicit storage consent.

## Starting a gameplay request

- Call `arcanos_gaming_hybrid_query` with `contractVersion: gaming-hybrid-v2`,
  a new operation key, the player's verbatim question, the game title and
  applicable context. Send unfamiliar titles as supplied. Resolve colloquial
  names and misspellings when the intended game is clear. Clarify only a choice
  that could materially change the answer.
- Include `semanticAssistance: { version: "gaming-semantic-v1" }` on the first
  call so ARCANOS can select the path before acquiring evidence. Add
  `interpretation` only when it contributes a short reading of the player's
  intent or identifies a referent established in the conversation. Keep all
  parts of the question and any conditions. For “How do I make this thing hit
  harder?” after the user names a weapon, identify that weapon in the hint.
  Keep unrelated chat, private information, URLs, and source text out of it.
- Reuse the supported context fields for the player's explicit preferences,
  spoiler limit, depth, edition, platform, version and progression claims.
  Carry relevant explicit context forward on follow-ups. When a player says
  “just got off the boat,” convey that description without inferring a
  completed GTA IV mission. Treat unresolved progress or edition as uncertain.
- Set `evidenceNeed` to `required` when the player asks to find or cite
  sources or needs verified facts. Use `specific_source` when the answer must
  use a particular guide or other source. Use `current_patch` for current
  version or balance claims and `live_status` for live status. Carry that
  requirement into follow-ups like “what about now?” when the earlier request
  supplies the meaning. The backend still evaluates the original question.
- If a follow-up refers to “that guide,” copy its exact URL into
  `requiredSourceUrl` only when the player supplied it in the conversation.
  The original question stays verbatim and any source links in it take
  precedence. The field can accompany `current_patch` or `live_status` so
  both checks apply. If the backend returns `SOURCE_LINK_REQUIRED`, ask for the
  specific link. Guessed URLs and general search results cannot substitute
  for the player's required guide.
- Keep the initial request transient by default. Interpretation cannot declare
  gameplay facts or player state verified, select sources, grant permissions,
  approve storage or expand any budget. Use the conversation already available
  to interpret the request without a separate model call.

## Handling the result

For `answer_ready` with `nextAction: answer`, present the backend's answer and
preserve its ordering, conditions, spoiler limits and qualifications. An answer
marked `model_knowledge` uses conversational knowledge and carries no
citations. Present its guidance directly with relevant uncertainty. On the
grounded path, present only the selected backend citations and preserve their
exact URLs, applicability and freshness. Wait for the backend to grant search
or currentness calls. Retain the original semantic assistance values in any
same-workflow clarification continuation. Bound replays to the same operation
and payload.

If a grounded workflow cannot verify the needed source or claims, relay its
limitation and follow its terminal or recovery instruction. Keep the existing
prohibition on switching tools, creating another workflow, or substituting
general knowledge after evidence, provider, transport, or authorization failure.

## Rollout compatibility

1. Independently review the backend PR and confirm the authorized backend
   release and deployed revision expose the added fields on the existing
   private MCP connection. Current v1 and ordinary v2 callers that omit the
   field keep their released evidence-grounded behavior.
2. Prepare the complete revised skill from the approved private baseline in
   the ignored migration directory. Incorporate this addendum into its initial
   query and answer presentation rules, preserving all other safeguards.
   Review the complete private diff and its exact candidate hash with the owner.
3. After owner approval and separate authorization to install or activate,
   refresh the existing connection's advertised tools and update the same
   private skill. Keep the existing plugin identity, OAuth scopes, connection
   and storage policy. An older backend rejects the extra field, so activate
   the instructions only after verifying deployed schema support.
