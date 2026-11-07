const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../../..');

// Load the actual pure classifier and its literal helper; no network, state,
// provider or compiled-dist dependency enters this contained attack fixture.
const source = fs.readFileSync(path.join(root, 'src/shared/gaming/gamingDocumentIngestionCore.ts'), 'utf8');
const registry = fs.readFileSync(path.join(root, 'src/shared/gaming/gamingGameRegistry.ts'), 'utf8');
const literalStart = registry.indexOf('export function gamingRegistryLiteralPattern(');
const literalEnd = registry.indexOf('\n}', literalStart) + 2;
const overviewStart = source.indexOf('export function isGamingDocumentOverviewOnly(');
const overviewEnd = source.indexOf('\nexport function classifyGamingDocumentQuality(', overviewStart);
const code = ts.transpileModule(registry.slice(literalStart, literalEnd) + '\n' + source.slice(overviewStart, overviewEnd), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;
const classifierModule = { exports: {} };
new Function('module', 'exports', code)(classifierModule, classifierModule.exports);
const overview = classifierModule.exports.isGamingDocumentOverviewOnly;
const heading = 'Elden Ring Practice - Shield guide';
const metadata = { title: heading, headings: heading };
const description = 'This article explains how to acquire the Practice - Shield.';
const separators = '-'.repeat(250000);
const started = performance.now();
const repeatedLabelAttack = overview(`${heading} Practice${separators}X ${description}`, metadata, 'Elden Ring');
const describedTopicAttack = overview(`${heading} This article explains how to acquire the Practice${separators}X.`, metadata, 'Elden Ring');
const validOverview = overview(`${heading} ${description}`, metadata, 'Elden Ring');
const multipleHeading = 'Elden Ring Practice - - - - - - - - Shield guide';
const multipleMetadata = { title: multipleHeading, headings: multipleHeading };
const multipleDescription = 'This article explains how to acquire the Practice - - - - - - - - Shield.';
const multipleSeparators = {
  repeatedLabelAttack: overview(`${multipleHeading} Practice${separators}X ${multipleDescription}`, multipleMetadata, 'Elden Ring'),
  describedTopicAttack: overview(`${multipleHeading} This article explains how to acquire the Practice${separators}X.`, multipleMetadata, 'Elden Ring'),
  validOverview: overview(`${multipleHeading} ${multipleDescription}`, multipleMetadata, 'Elden Ring')
};
// Interior hyphens are part of one nominal token, not fresh subject starts.
const alternatingSubject = overview(`This article explains how to acquire the ${'a-'.repeat(50000)}X.`, undefined, 'Elden Ring');
process.stdout.write(JSON.stringify({ elapsedMs: Math.round(performance.now() - started),
  repeatedLabelAttack, describedTopicAttack, validOverview, multipleSeparators, alternatingSubject }));
