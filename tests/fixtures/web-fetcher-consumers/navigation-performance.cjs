const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const cheerio = require('cheerio');
const root = path.resolve(__dirname, '../../..');

/** Load the real pure extraction entry point in a bounded child. Network is
 * denied, environment defaults are fixed, and no compiled dist is required. */
function loadSource(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const module = { exports: {} };
  const requireBoundary = id => {
    if (id === 'axios') return { default: { get() { throw new Error('Fixture forbids network'); } } };
    if (id === 'cheerio') return cheerio;
    if (id === '@platform/runtime/env.js') return {
      getEnv: () => undefined, getEnvIntegerAtLeast: (_key, fallback) => fallback
    };
    if (id === './protectedDocumentByteBudget.js') return {};
    if (id === './gaming/gamingDocumentTextNormalization.js') {
      return loadSource('src/shared/gaming/gamingDocumentTextNormalization.ts');
    }
    if (id.startsWith('node:')) return require(id);
    throw new Error(`Unexpected fixture dependency: ${id}`);
  };
  new Function('require', 'module', 'exports', code)(requireBoundary, module, module.exports);
  return module.exports;
}

const { extractFetchAndCleanDocument } = loadSource('src/shared/webFetcher.ts');
const prose = 'Synthetic observatory report records three blue lamps. '.repeat(2000);
const expected = 'START ' + prose.trim() + ' END';
const body = '<html><body>' + '<div class="has-guide-sidebar">'.repeat(2000)
  + '<article><p>' + expected + '</p><a href="/methods">Read methods</a></article>'
  + '</div>'.repeat(2000) + '<aside>FURNITURE_MARKER</aside></body></html>';
const started = performance.now();
const legacy = extractFetchAndCleanDocument('https://research.example.org/report', body, 'text/html', 9000);
const optedIn = extractFetchAndCleanDocument('https://research.example.org/report', body, 'text/html', 200000, {
  preservePrimaryContentHeading: true, primaryContentSelectors: ['article'],
  removeSelectors: ['aside', 'nav', "[class$='-sidebar']"], retainFullSelectedText: true,
  maxSelectedTextChars: 200000, includeLinks: false
});
process.stdout.write(JSON.stringify({
  bytes: Buffer.byteLength(body), elements: 2006, elapsedMs: Math.round(performance.now() - started),
  legacyLength: legacy.combined.length, legacyPrefix: legacy.combined === expected.slice(0, 9000),
  legacyLinks: legacy.links,
  fullSelectedText: optedIn.text === expected + ' Read methods',
  fullCombinedText: optedIn.combined === optedIn.text,
  omittedFurniture: !optedIn.text.includes('FURNITURE_MARKER'), optedInLinks: optedIn.links
}));
