/** Repository-reviewed transport data; these rules never grant source authority or gameplay identity. */
export const GAMING_SOURCE_TRANSPORT_DATA_VERSION = 'gaming-source-transport-data/v1';
export const GAMING_SOURCE_TRANSPORT_DATA_REVISION = '2026-10-10.1';
export const GAMING_SOURCE_TRANSPORT_DATA_PROVENANCE = {
  origin: 'repository-defaults',
  migratedFrom: '200463b3aac65eb494f71d842c1e2b0378530bfb',
  reviewPolicy: 'owner-reviewed-exact-transport-rules'
} as const;

export const GAMING_LOW_SIGNAL_DOMAINS = [
  "facebook.com",
  "instagram.com",
  "pinterest.com",
  "tiktok.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "youtu.be"
];
export const GAMING_URL_SHORTENER_DOMAINS = [
  "bit.ly",
  "buff.ly",
  "cutt.ly",
  "goo.gl",
  "is.gd",
  "ow.ly",
  "rebrand.ly",
  "shorturl.at",
  "tinyurl.com",
  "t.co"
];
export const GAMING_SEARCH_ENGINE_DOMAINS = [
  "bing.com",
  "duckduckgo.com",
  "google.com",
  "search.brave.com",
  "search.yahoo.com"
];

/** Exact host membership and exact/path-prefix literals preserve the two preexisting transitions. */
export const GAMING_REVIEWED_PUBLISHER_REDIRECT_PAIRS = [
  { id: 'wow-specialist-apex-www', hosts: ['icy-veins.com', 'www.icy-veins.com'],
    exactPaths: [], pathPrefixes: ['/wow/'] },
  { id: 'swtor-patch-apex-www', hosts: ['swtor.com', 'www.swtor.com'],
    exactPaths: ['/patchnotes'], pathPrefixes: ['/patchnotes/'] }
] as const;
