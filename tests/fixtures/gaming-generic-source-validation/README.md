# Synthetic generic source-validation fixtures

These repository-authored HTML documents contain no captured publisher responses
or copied guide passages. Their game details are test inputs, not independently
verified gameplay recommendations. Every publisher URL uses a reserved example
host, and every publisher declares community provenance in the manifest.

The integration suite replaces only external DNS/HTTP/provider transports and
traps persistence calls. Protected acquisition, document extraction, identity,
source CLEAR, hybrid-v2 selection, Trinity intake/reasoning/final composition,
and final-answer CLEAR execute real code. Successful mock responses demonstrate
pipeline correctness; they do not establish live publisher acceptance, real
model quality, or production readiness.

| Fixture | Game | Layout and purpose |
| --- | --- | --- |
| `zelda-wiki.html` | The Legend of Zelda: Tears of the Kingdom | Wiki wrapper; ordinary “in the game” prose; intact food/stamina guidance; gameplay use of “save stamina” |
| `elite-discussion.html` | Elite Dangerous | Discussion post; benign instructions to complete a mission |
| `witcher-location.html` | The Witcher 3 | Specialist article; White Orchard topic heading with independently acquired game ownership |
| `xenoblade-location.html` | Xenoblade Chronicles X | Wiki wrapper; Mira topic heading with independently acquired game ownership |
| `invented-build.html` | Bramble Meridian (unregistered) | Player blog; ordinary list prose; local comparison to another game; quoted recommendation |
| `invented-quest.html` | Clockwork Estuary (unregistered) | Specialist article; quest ownership without registry changes |
| `elden-build.html` | Elden Ring | Player blog; existing beginner Samurai acceptance path |
| `fallout-build.html` | Fallout 76 | Discussion post; existing beginner Heavy Gunner acceptance path |
| `partial-weapon.html` | Bramble Meridian | Intact starting-blade contribution that cannot independently satisfy the complete request |
| `partial-stats.html` | Bramble Meridian | Complementary stats contribution; neither partial source alone provides both requested topics |
| `strategy-shield.html` | Bramble Meridian | Defensive strategy with a stamina tradeoff |
| `strategy-blade.html` | Bramble Meridian | Alternative offensive strategy with a blocking tradeoff |

All article fixtures exclude navigation and related-game furniture from gameplay
evidence. The suite also derives variants for acquired alternate-title
declarations, contradictory global game labels, conflicting primary headings,
malicious assistant instructions, incompatible DLC/edition scopes and HTTP 403.
Alias declarations use a separate article-body paragraph and independently
corroborated canonical prose. Edition conflicts do not imply that an unreviewed
edition has equivalent mechanics to its parent game.
