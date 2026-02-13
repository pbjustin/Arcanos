import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST_DIRECTORY_URL = pathToFileURL(path.resolve(process.cwd(), 'dist') + path.sep);

const ALIAS_PREFIX_TO_DIST_SUBPATH = [
  ['@core/lib/', 'lib/'],
  ['@platform/', 'platform/'],
  ['@core/', 'core/'],
  ['@shared/', 'shared/'],
  ['@services/', 'services/'],
  ['@transport/', 'transport/'],
  ['@routes/', 'routes/'],
];

/**
 * Resolve ARCANOS TypeScript path aliases at Node.js runtime.
 * Inputs: unresolved import specifier and default Node resolver context.
 * Output: URL for aliased modules; otherwise defers to Node defaults.
 * Edge case: Non-aliased specifiers are untouched for compatibility.
 */
export function resolve(specifier, context, defaultResolve) {
  for (const [aliasPrefix, distSubpathPrefix] of ALIAS_PREFIX_TO_DIST_SUBPATH) {
    //audit assumption: internal imports use configured alias prefixes; risk: unknown aliases fail runtime.
    //audit invariant: every mapped alias points to an emitted dist/ path; handling: rewrite only known prefixes.
    if (specifier.startsWith(aliasPrefix)) {
      const specifierSuffix = specifier.slice(aliasPrefix.length);
      const normalizedSpecifierPath = path.posix.join(distSubpathPrefix, specifierSuffix);
      const resolvedAliasUrl = new URL(normalizedSpecifierPath, DIST_DIRECTORY_URL).href;

      return defaultResolve(resolvedAliasUrl, context, defaultResolve);
    }
  }

  //audit assumption: unresolved non-alias modules should follow standard Node resolution.
  //audit risk: wrapping default errors could hide root cause.
  //audit handling: delegate directly so original structured errors are preserved.
  return defaultResolve(specifier, context, defaultResolve);
}
