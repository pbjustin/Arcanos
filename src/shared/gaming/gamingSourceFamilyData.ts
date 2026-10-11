/** Source-family data groups ownership conservatively; it grants no source authority or acquired evidence. */
export interface GamingSourceFamilyRegistry {
  version: string;
  families: readonly {
    id: string;
    hosts: readonly string[];
    includeSubdomains: boolean;
    provenance: { reviewedAt: string; references: readonly string[] };
  }[];
}

/** Group affiliated brands together even when their individual editorial policies differ.
 * A changed ownership assertion requires a reviewed registry revision and provenance.
 * Absence from this registry never establishes publisher independence. */
export const GAMING_SOURCE_FAMILY_DATA: GamingSourceFamilyRegistry = {
  version: 'gaming-source-families/v1',
  families: [
    { id: 'bandai-namco', hosts: ['bandainamcoent.com', 'bandainamcoent.eu'], includeSubdomains: true,
      provenance: { reviewedAt: '2026-10-10', references: ['https://www.bandainamcoent.com/legal/privacy'] } },
    { id: 'microsoft-gaming', hosts: ['blizzard.com', 'minecraft.net', 'xbox.com', 'bethesda.net'], includeSubdomains: true,
      provenance: { reviewedAt: '2026-10-10', references: ['https://www.microsoft.com/en-us/Investor/acquisition-history.aspx'] } },
    { id: 'sony-gaming', hosts: ['bungie.net', 'playstation.com'], includeSubdomains: true,
      provenance: { reviewedAt: '2026-10-10', references: ['https://www.sie.com/en/blog/sony-interactive-entertainment-to-acquire-bungie/'] } }
  ]
};
