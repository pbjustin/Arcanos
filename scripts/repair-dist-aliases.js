import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const DEFAULT_DIST_DIRECTORY = 'dist';
const CHECK_MODE = 'check';
const REWRITE_MODE = 'rewrite';

const exactAliasTargetBySpecifier = new Map([
  ['@platform', 'platform/index.js'],
  ['@shared', 'shared/index.js'],
  ['@transport', 'transport/index.js'],
]);

const aliasPrefixTargetMappings = [
  { aliasPrefix: '@platform/', targetPrefix: 'platform/' },
  { aliasPrefix: '@core/', targetPrefix: 'core/' },
  { aliasPrefix: '@routes/', targetPrefix: 'routes/' },
  { aliasPrefix: '@services/', targetPrefix: 'services/' },
  { aliasPrefix: '@transport/', targetPrefix: 'transport/' },
  { aliasPrefix: '@shared/', targetPrefix: 'shared/' },
];

/**
 * Parse CLI arguments for alias repair/check behavior.
 * Inputs: raw CLI args after node script path.
 * Output: object with mode and dist directory.
 * Edge cases: unknown flags throw an error to avoid silent misconfiguration.
 */
function parseCommandLineArguments(rawArguments) {
  let mode = REWRITE_MODE;
  let distDirectory = DEFAULT_DIST_DIRECTORY;

  for (const argumentValue of rawArguments) {
    //audit Assumption: only known flags should be accepted; risk: accidental typo masks intent; invariant: parser fails fast on unknown flags; handling: throw explicit error.
    if (argumentValue === '--check') {
      mode = CHECK_MODE;
      continue;
    }

    //audit Assumption: explicit rewrite flag is allowed for readability; risk: ambiguous mode handling; invariant: rewrite mode remains default; handling: parse and continue.
    if (argumentValue === '--rewrite') {
      mode = REWRITE_MODE;
      continue;
    }

    //audit Assumption: dist directory override may be needed for alternate output paths; risk: pointing to wrong tree; invariant: value must be non-empty; handling: validate and throw on empty.
    if (argumentValue.startsWith('--dist=')) {
      const providedDistDirectory = argumentValue.slice('--dist='.length).trim();
      if (!providedDistDirectory) {
        throw new Error('Flag --dist requires a non-empty directory path.');
      }
      distDirectory = providedDistDirectory;
      continue;
    }

    throw new Error(`Unknown argument: ${argumentValue}`);
  }

  return { mode, distDirectory };
}

/**
 * Collect all JavaScript files under a directory.
 * Inputs: dist root directory path.
 * Output: array of absolute .js file paths.
 * Edge cases: skips non-js files and traverses nested folders recursively.
 */
async function collectJavaScriptFilesRecursively(distRootPath) {
  const javaScriptFilePaths = [];
  const pendingDirectoryPaths = [distRootPath];

  while (pendingDirectoryPaths.length > 0) {
    const currentDirectoryPath = pendingDirectoryPaths.pop();
    const directoryEntries = await fs.readdir(currentDirectoryPath, { withFileTypes: true });

    for (const directoryEntry of directoryEntries) {
      const entryPath = path.join(currentDirectoryPath, directoryEntry.name);

      //audit Assumption: directory traversal should include all nested output files; risk: missed alias in child folders; invariant: every child directory is queued; handling: push directory for later scan.
      if (directoryEntry.isDirectory()) {
        pendingDirectoryPaths.push(entryPath);
        continue;
      }

      //audit Assumption: only runtime JavaScript files need import rewriting; risk: touching source maps can corrupt debug metadata; invariant: limit writes to .js files; handling: filter by suffix.
      if (directoryEntry.isFile() && entryPath.endsWith('.js')) {
        javaScriptFilePaths.push(entryPath);
      }
    }
  }

  return javaScriptFilePaths;
}

/**
 * Resolve an alias specifier to a dist-relative target path.
 * Inputs: import specifier string.
 * Output: dist-relative target file path or null when no managed alias matches.
 * Edge cases: preserves third-party scoped packages like @prisma/client by returning null.
 */
function resolveAliasTargetPath(aliasSpecifier) {
  const exactTargetPath = exactAliasTargetBySpecifier.get(aliasSpecifier);
  if (exactTargetPath) {
    return exactTargetPath;
  }

  for (const aliasPrefixMapping of aliasPrefixTargetMappings) {
    //audit Assumption: aliases are prefix-based and deterministic; risk: partial prefix collision; invariant: first matching configured prefix maps to one target root; handling: explicit startsWith check.
    if (aliasSpecifier.startsWith(aliasPrefixMapping.aliasPrefix)) {
      const aliasSuffix = aliasSpecifier.slice(aliasPrefixMapping.aliasPrefix.length);
      return `${aliasPrefixMapping.targetPrefix}${aliasSuffix}`;
    }
  }

  return null;
}

/**
 * Build a relative import specifier from one dist file to another.
 * Inputs: current file path, dist-relative target path, dist root path.
 * Output: normalized relative module specifier using forward slashes.
 * Edge cases: prefixes ./ for same-folder imports to keep ESM resolution valid.
 */
function buildRelativeSpecifier(currentFilePath, targetPathFromDistRoot, distRootPath) {
  const currentDirectoryPath = path.dirname(currentFilePath);
  const absoluteTargetPath = path.resolve(distRootPath, targetPathFromDistRoot);
  let relativeSpecifier = path.relative(currentDirectoryPath, absoluteTargetPath).split(path.sep).join('/');

  //audit Assumption: ESM relative imports require explicit ./ prefix for sibling paths; risk: bare path interpreted as package name; invariant: specifier starts with ./ or ../; handling: prepend ./ when needed.
  if (!relativeSpecifier.startsWith('./') && !relativeSpecifier.startsWith('../')) {
    relativeSpecifier = `./${relativeSpecifier}`;
  }

  return relativeSpecifier;
}

/**
 * Rewrite alias specifiers in one JS file source string.
 * Inputs: source text, file path, dist root path, execution mode.
 * Output: updated source plus counts for alias references and replacements.
 * Edge cases: rewrites both static `from` imports and dynamic `import()` expressions.
 */
function rewriteAliasSpecifiersInSource({
  sourceText,
  currentFilePath,
  distRootPath,
  mode,
}) {
  let knownAliasReferenceCount = 0;
  let replacementCount = 0;
  let updatedSourceText = sourceText;

  const replaceKnownAliasSpecifier = (specifierValue) => {
    const aliasTargetPath = resolveAliasTargetPath(specifierValue);

    //audit Assumption: non-managed specifiers must remain untouched; risk: breaking external dependencies; invariant: only configured aliases are transformed; handling: return null when no managed alias exists.
    if (!aliasTargetPath) {
      return null;
    }

    knownAliasReferenceCount += 1;

    //audit Assumption: check mode should report without modifying output; risk: accidental mutation during validation; invariant: source text unchanged in check mode; handling: short-circuit with null rewrite target.
    if (mode === CHECK_MODE) {
      return specifierValue;
    }

    const rewrittenSpecifier = buildRelativeSpecifier(currentFilePath, aliasTargetPath, distRootPath);
    if (rewrittenSpecifier !== specifierValue) {
      replacementCount += 1;
    }
    return rewrittenSpecifier;
  };

  updatedSourceText = updatedSourceText.replace(/(from\s+)(['"])([^'"]+)\2/g, (fullMatch, fromKeyword, quoteCharacter, specifierValue) => {
    const rewrittenSpecifier = replaceKnownAliasSpecifier(specifierValue);
    if (rewrittenSpecifier === null) {
      return fullMatch;
    }
    return `${fromKeyword}${quoteCharacter}${rewrittenSpecifier}${quoteCharacter}`;
  });

  updatedSourceText = updatedSourceText.replace(/(import\(\s*)(['"])([^'"]+)\2(\s*\))/g, (fullMatch, importPrefix, quoteCharacter, specifierValue, importSuffix) => {
    const rewrittenSpecifier = replaceKnownAliasSpecifier(specifierValue);
    if (rewrittenSpecifier === null) {
      return fullMatch;
    }
    return `${importPrefix}${quoteCharacter}${rewrittenSpecifier}${quoteCharacter}${importSuffix}`;
  });

  return {
    updatedSourceText,
    knownAliasReferenceCount,
    replacementCount,
  };
}

/**
 * Process dist files in check or rewrite mode.
 * Inputs: mode + dist directory options.
 * Output: summary object with discovered aliases and applied replacements.
 * Edge cases: fails when dist root is missing to avoid false-positive success.
 */
async function processDistFiles({ mode, distDirectory }) {
  const distRootPath = path.resolve(process.cwd(), distDirectory);

  //audit Assumption: dist must exist before startup/build checks; risk: passing validation with no compiled output; invariant: dist root exists and is a directory; handling: throw explicit error.
  const distRootStats = await fs.stat(distRootPath).catch(() => null);
  if (!distRootStats || !distRootStats.isDirectory()) {
    throw new Error(`Dist directory not found: ${distRootPath}`);
  }

  const javaScriptFilePaths = await collectJavaScriptFilesRecursively(distRootPath);
  let totalKnownAliasReferenceCount = 0;
  let totalReplacementCount = 0;
  const filesWithAliasReferences = [];

  for (const javaScriptFilePath of javaScriptFilePaths) {
    const sourceText = await fs.readFile(javaScriptFilePath, 'utf8');
    const rewriteResult = rewriteAliasSpecifiersInSource({
      sourceText,
      currentFilePath: javaScriptFilePath,
      distRootPath,
      mode,
    });

    //audit Assumption: alias references indicate unresolved compile output; risk: startup crash from bare alias package resolution; invariant: check mode must surface all references; handling: record per-file counts.
    if (rewriteResult.knownAliasReferenceCount > 0) {
      filesWithAliasReferences.push({
        filePath: javaScriptFilePath,
        aliasCount: rewriteResult.knownAliasReferenceCount,
      });
      totalKnownAliasReferenceCount += rewriteResult.knownAliasReferenceCount;
    }

    //audit Assumption: rewrite mode should persist transformed imports atomically per file; risk: partial writes; invariant: each changed file is fully rewritten; handling: write full file content when replacements were made.
    if (mode === REWRITE_MODE && rewriteResult.replacementCount > 0) {
      await fs.writeFile(javaScriptFilePath, rewriteResult.updatedSourceText, 'utf8');
      totalReplacementCount += rewriteResult.replacementCount;
    }
  }

  return {
    distRootPath,
    scannedFileCount: javaScriptFilePaths.length,
    totalKnownAliasReferenceCount,
    totalReplacementCount,
    filesWithAliasReferences,
  };
}

/**
 * Print a concise summary for humans and CI logs.
 * Inputs: mode and processing summary.
 * Output: writes status lines to stdout/stderr.
 * Edge cases: truncates file list to keep logs readable on large builds.
 */
function printSummary({ mode, summary }) {
  const truncatedFileSummaries = summary.filesWithAliasReferences.slice(0, 15);

  for (const fileSummary of truncatedFileSummaries) {
    const relativeFilePath = path.relative(process.cwd(), fileSummary.filePath).split(path.sep).join('/');
    console.log(`- ${relativeFilePath}: ${fileSummary.aliasCount} alias import(s)`);
  }

  if (summary.filesWithAliasReferences.length > truncatedFileSummaries.length) {
    console.log(`- ... ${summary.filesWithAliasReferences.length - truncatedFileSummaries.length} more file(s)`);
  }

  //audit Assumption: check mode must fail fast when aliases remain; risk: deployment proceeds with broken runtime imports; invariant: exit code 1 if unresolved aliases exist; handling: throw with explicit count.
  if (mode === CHECK_MODE && summary.totalKnownAliasReferenceCount > 0) {
    throw new Error(
      `Found ${summary.totalKnownAliasReferenceCount} unresolved alias import(s) across ` +
      `${summary.filesWithAliasReferences.length} file(s) in ${summary.distRootPath}.`
    );
  }

  if (mode === CHECK_MODE) {
    console.log(
      `[dist-alias] Check passed. scannedFiles=${summary.scannedFileCount} ` +
      `unresolvedAliases=${summary.totalKnownAliasReferenceCount}`
    );
    return;
  }

  console.log(
    `[dist-alias] Rewrite complete. scannedFiles=${summary.scannedFileCount} ` +
    `detectedAliases=${summary.totalKnownAliasReferenceCount} replacements=${summary.totalReplacementCount}`
  );
}

/**
 * Entrypoint for dist alias repair/check.
 * Inputs: process.argv flags.
 * Output: exits 0 on success and 1 on failure.
 * Edge cases: unknown CLI flags or missing dist folder return non-zero status.
 */
async function main() {
  const options = parseCommandLineArguments(process.argv.slice(2));
  const summary = await processDistFiles(options);
  printSummary({ mode: options.mode, summary });
}

void main().catch((error) => {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`[dist-alias] Failed: ${errorMessage}`);
  process.exit(1);
});
