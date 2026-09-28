import { mkdir, readdir, realpath, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  baselineFingerprint, captureBaseline, digest, maxFileSize, noSymlinkAncestors,
  packageFingerprint, readSafeFile, relativeFile, requireCondition, reviewed, safeContent,
  skillPath, validateArtifact, validateBaseline
} from './tutor-migration.mjs';

export const teachingPlaceholder = '{{PUBLISHED_TUTOR_INSTRUCTIONS}}';
export const compositionReportPath = 'composition-report.json';
const distributionPaths = Object.freeze(['.app.json', 'plugin.json', skillPath]);
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultPackageRoot = path.join(repositoryRoot, 'integrations/arcanos-tutor/package');
// Category names alone cannot establish a semantic rule for a future baseline.
// These relationships were reviewed only for this exact private expectation artifact.
const reviewedBehaviorArtifactSha256 = 'd52e1cbae08759653b2876b91b8d1edceb947f59d7bc30aa401ecdbd6f7c27ae';
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const metadata = (file, value) => ({ path: file, sha256: value.sha256, sizeBytes: value.sizeBytes });

/** These lexical source locators are review aids, never executed teaching tests. */
const ruleLocators = Object.freeze({
  learner_level_assessment: /prior knowledge|learner[^\r\n]{0,40}level/iu,
  diagnostic_questioning: /diagnos[^\r\n]*question|question[^\r\n]*diagnos/iu,
  adaptive_explanation: /adapt/iu,
  scaffolding_hints: /\bscaffold|\bhints?\b/iu,
  worked_examples: /\bworked examples?\b/iu,
  practice_generation: /\bpractice\b/iu,
  error_correction: /\bmisconceptions?\b|\bmistakes?\b|error correction/iu,
  comprehension_checks: /check[^\r\n]*(?:understand|learn)|(?:understand|learn)[^\r\n]*check/iu,
  follow_up_handling: /follow.up/iu,
  response_formatting: /number|structur|format/iu,
  concise_answer_compliance: /\bconcise\b|\bbrief\b|short answer|sentence limit/iu,
  uncertainty: /\buncertain|\bunsure\b|do not guess|cannot verify/iu,
  boundaries_refusals: /\brefus|\bunsafe\b|\bdisallow|must not|do not/iu,
  progress_memory_expectations: /\bsession|\bprogress\b|\bmemory\b|\bpersist|\brecall\b/iu,
  tone_instructional_stance: /\bfriendly\b|\bsupportive\b|\bteacher\b|pedagog|\btutor\b|\btone\b/iu
});

async function privateRoot(inputRoot) {
  const resolved = path.resolve(inputRoot);
  requireCondition(path.basename(resolved) === 'arcanos-tutor' &&
    path.basename(path.dirname(resolved)) === '.local-migration', 'PRIVATE_INPUT_ROOT_REQUIRED');
  await noSymlinkAncestors(resolved);
  const projectRoot = path.dirname(path.dirname(resolved));
  const ignored = spawnSync('git', ['-C', projectRoot, 'check-ignore', '--quiet', '--no-index', '--',
    '.local-migration/arcanos-tutor/'], { encoding: 'utf8', windowsHide: true });
  const tracked = spawnSync('git', ['-C', projectRoot, 'ls-files', '--',
    '.local-migration/arcanos-tutor/'], { encoding: 'utf8', windowsHide: true });
  requireCondition(ignored.status === 0 && tracked.status === 0 && tracked.stdout.trim() === '',
    'PRIVATE_INPUT_IGNORE_REQUIRED');
  return realpath(resolved);
}

function outputLocation(inputRoot, outputDirectory = 'composed-skill-v1') {
  const absolute = path.resolve(inputRoot, outputDirectory);
  const relative = path.relative(inputRoot, absolute).split(path.sep).join('/');
  relativeFile(relative);
  requireCondition(absolute.startsWith(`${inputRoot}${path.sep}`), 'PRIVATE_OUTPUT_REQUIRED');
  return { absolute, relative };
}

async function packageFiles(root, references = []) {
  await noSymlinkAncestors(root);
  const actualPaths = [];
  async function visit(relative = '') {
    const current = path.join(root, relative);
    await noSymlinkAncestors(current);
    for (const item of await readdir(current, { withFileTypes: true })) {
      requireCondition(!item.isSymbolicLink(), 'SYMLINK_NOT_ALLOWED');
      const next = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await visit(next);
      else { requireCondition(item.isFile(), 'PACKAGE_ENTRY_INVALID'); actualPaths.push(next); }
    }
  }
  await visit();
  const allowed = [...distributionPaths, ...references.map(item => item.packagePath).sort()];
  requireCondition(equal(actualPaths.sort(), [...allowed].sort()), 'COMPOSITION_PACKAGE_FILES_INVALID');
  const files = new Map(await Promise.all(allowed.map(async file => [file, await readSafeFile(root, file)])));
  for (const item of references) requireCondition(files.get(item.packagePath).sha256 === item.sha256 &&
    files.get(item.packagePath).sizeBytes === item.sizeBytes, 'REFERENCE_DIGEST_MISMATCH');
  requireCondition([...files.values()].reduce((size, file) => size + file.sizeBytes, 0) <= 4 * maxFileSize,
    'COMPOSITION_PACKAGE_TOO_LARGE');
  return files;
}

async function referenceReview(options, packageRoot) {
  let review = options.referenceReview;
  if (!review) {
    const file = path.resolve(options.referenceReviewPath ?? path.join(packageRoot, '../reference-review.json'));
    review = JSON.parse((await readSafeFile(path.dirname(file), path.basename(file))).content);
  }
  requireCondition(review.schemaVersion === 1 && Array.isArray(review.references), 'REFERENCE_REVIEW_INVALID');
  const paths = new Set();
  for (const item of review.references) {
    validateArtifact({ path: item.packagePath, sha256: item.sha256, sizeBytes: item.sizeBytes });
    requireCondition(item.approvedForRepository === true && reviewed(item) &&
      item.packagePath.startsWith('skills/arcanos-tutor/references/') &&
      /\.(md|txt|json|csv)$/u.test(item.packagePath) && !paths.has(item.packagePath), 'REFERENCE_PUBLICATION_NOT_APPROVED');
    paths.add(item.packagePath);
  }
  return review;
}

/** Map every source byte exactly once; labels never include private section titles. */
export function instructionSectionMap(instructions, outputStartByte) {
  const starts = [0];
  for (const match of instructions.matchAll(/\r?\n[ \t]*\r?\n/gu)) {
    const next = match.index + match[0].length;
    if (next < instructions.length) starts.push(next);
  }
  requireCondition(starts.length <= 512, 'TOO_MANY_INSTRUCTION_SECTIONS');
  const sections = starts.map((start, index) => {
    const end = starts[index + 1] ?? instructions.length;
    const bytes = Buffer.from(instructions.slice(start, end), 'utf8');
    const sourceStartByte = Buffer.byteLength(instructions.slice(0, start), 'utf8');
    const suffix = String(index + 1).padStart(3, '0');
    return {
      sourceId: `instruction-section-${suffix}`, targetId: `teaching-core-section-${suffix}`,
      sourceStartByte, sourceEndByte: sourceStartByte + bytes.length,
      outputStartByte: outputStartByte + sourceStartByte,
      outputEndByte: outputStartByte + sourceStartByte + bytes.length, sha256: digest(bytes)
    };
  });
  return sections;
}

async function teachingRuleMap(inputRoot, configuration, sections, owner) {
  const instructions = configuration.instructions;
  const bytes = Buffer.from(instructions, 'utf8');
  const binding = owner.reviewContext?.expectedBehaviorArtifact;
  validateArtifact(binding);
  const artifact = await readSafeFile(inputRoot, binding.path);
  requireCondition(artifact.sha256 === binding.sha256 && artifact.sizeBytes === binding.sizeBytes,
    'APPROVED_BEHAVIOR_ARTIFACT_CHANGED');
  const behavior = JSON.parse(artifact.content);
  requireCondition(Array.isArray(behavior.cases) && equal(behavior.cases.map(item => item.expectedBehavior),
    configuration.representativeBehavior), 'APPROVED_BEHAVIOR_MISMATCH');
  const lines = instructions.split(/\r?\n/u);
  const lineStarts = [0];
  for (const match of instructions.matchAll(/\r?\n/gu)) lineStarts.push(match.index + match[0].length);
  const sourceByBehavior = new Map();
  for (const item of behavior.cases) {
    requireCondition(typeof item.id === 'string' && /^[a-z][a-z0-9-]*$/u.test(item.id) &&
      !sourceByBehavior.has(item.id) && Array.isArray(item.privateSourceExcerpts), 'BEHAVIOR_SOURCE_INVALID');
    const ids = new Set();
    for (const excerpt of item.privateSourceExcerpts) {
      requireCondition(Number.isSafeInteger(excerpt.line) && excerpt.line > 0 && excerpt.line <= lines.length &&
        excerpt.text === lines[excerpt.line - 1] && excerpt.sha256 === digest(excerpt.text), 'BEHAVIOR_SOURCE_EXCERPT_CHANGED');
      const start = Buffer.byteLength(instructions.slice(0, lineStarts[excerpt.line - 1]), 'utf8');
      const end = start + Buffer.byteLength(excerpt.text, 'utf8');
      for (const section of sections) if (section.sourceStartByte <= start && section.sourceEndByte >= end) ids.add(section.sourceId);
    }
    sourceByBehavior.set(item.id, [...ids]);
  }
  // These mappings use the previously reviewed expectation categories, not a
  // keyword match as proof of pedagogical meaning. Ambiguous topics stay pending.
  const acceptedCategories = {
    learner_level_assessment: ['tutoring'], diagnostic_questioning: ['tutoring'], adaptive_explanation: ['tutoring'],
    practice_generation: ['practice'], comprehension_checks: ['practice'], response_formatting: ['structure', 'formatting'],
    progress_memory_expectations: ['memory']
  };
  return Object.entries(ruleLocators).map(([id, locator]) => {
    const candidateSourceIds = sections.filter(section => locator.test(bytes.subarray(
      section.sourceStartByte, section.sourceEndByte).toString('utf8'))).map(section => section.sourceId);
    const sourceBehaviorIds = (artifact.sha256 === reviewedBehaviorArtifactSha256 ? acceptedCategories[id] ?? [] : [])
      .filter(key => sourceByBehavior.has(key));
    const approvedSourceIds = [...new Set(sourceBehaviorIds.flatMap(key => sourceByBehavior.get(key)))];
    return { id, status: approvedSourceIds.length ? 'APPROVED_EXPECTATION_SOURCE_MAPPED'
      : candidateSourceIds.length ? 'SEMANTIC_REVIEW_PENDING' : 'NOT_ESTABLISHED_IN_BASELINE',
    approvedSourceIds, sourceBehaviorIds, candidateSourceIds,
    sourceArtifactSha256: artifact.sha256, behavioralReview: 'PENDING',
    limitation: id === 'progress_memory_expectations'
        ? 'Session or progress wording does not establish durable storage, recall or learner profiles.'
        : 'Source preservation and an approved expectation do not prove behavior of this newly composed skill. Lexical candidates alone are not approved rule mappings.' };
  });
}

async function prepare(options) {
  const inputRoot = await privateRoot(options.inputRoot);
  let baseline = options.baseline;
  if (!baseline) {
    const baselinePath = path.resolve(options.baselineInventoryPath ?? path.join(repositoryRoot,
      'integrations/arcanos-tutor/baseline.inventory.json'));
    baseline = JSON.parse((await readSafeFile(path.dirname(baselinePath), path.basename(baselinePath))).content);
  }
  validateBaseline(baseline);
  requireCondition(baseline.status === 'VERIFIED', 'APPROVED_BASELINE_REQUIRED');
  const captured = await captureBaseline(inputRoot, baseline.configuration.path);
  requireCondition(equal(captured.configuration, baseline.configuration) && equal(captured.knowledge, baseline.knowledge),
    'APPROVED_BASELINE_BYTES_CHANGED');
  const configurationFile = await readSafeFile(inputRoot, baseline.configuration.path);
  const configuration = JSON.parse(configurationFile.content);
  const fingerprint = baselineFingerprint(baseline);
  relativeFile(options.ownerReviewFile);
  const ownerFile = await readSafeFile(inputRoot, options.ownerReviewFile);
  const owner = JSON.parse(ownerFile.content);
  requireCondition(owner.latestPublishedConfirmed === true && owner.completeTranscriptionApproved === true &&
    owner.representativeBehaviorApproved === true && owner.reviewedBy === baseline.publicationReview.reviewedBy &&
    owner.reviewedAt === baseline.publicationReview.reviewedAt &&
    baseline.publicationReview.evidenceIds.includes(owner.evidenceId) &&
    owner.reviewContext?.configurationSha256 === configurationFile.sha256 &&
    owner.reviewContext?.baselineFingerprint === fingerprint, 'OWNER_PUBLICATION_REVIEW_MISMATCH');
  const templatePath = options.templatePath && path.resolve(options.templatePath);
  const packageRoot = path.resolve(options.packageRoot ?? (templatePath
    ? path.resolve(path.dirname(templatePath), '../..') : defaultPackageRoot));
  requireCondition(!templatePath || templatePath === path.join(packageRoot, skillPath), 'TEMPLATE_PATH_MISMATCH');
  const references = await referenceReview(options, packageRoot);
  const templates = await packageFiles(packageRoot, references.references);
  const template = templates.get(skillPath).content;
  requireCondition(template.split(teachingPlaceholder).length === 2, 'TEACHING_PLACEHOLDER_COUNT_INVALID');
  requireCondition(!configuration.instructions.includes(teachingPlaceholder), 'SOURCE_PLACEHOLDER_COLLISION');
  const offset = template.indexOf(teachingPlaceholder);
  const skill = `${template.slice(0, offset)}${configuration.instructions}${template.slice(offset + teachingPlaceholder.length)}`;
  const skillBytes = Buffer.from(skill, 'utf8');
  safeContent(skill);
  requireCondition(skillBytes.length <= maxFileSize, 'COMPOSED_SKILL_TOO_LARGE');
  const files = new Map(templates);
  files.set(skillPath, { content: skill, bytes: skillBytes, sha256: digest(skillBytes), sizeBytes: skillBytes.length });
  const sections = instructionSectionMap(configuration.instructions, Buffer.byteLength(template.slice(0, offset), 'utf8'));
  const report = {
    schemaVersion: 1, kind: 'tutor-skill-composition', status: 'COMPOSED_PENDING_OWNER_REVIEW',
    baselineFingerprint: fingerprint, configuration: metadata(baseline.configuration.path, configurationFile),
    baselineInstructions: { fieldSha256: baseline.configuration.fields.instructions.sha256,
      textSha256: digest(configuration.instructions), sizeBytes: Buffer.byteLength(configuration.instructions, 'utf8') },
    publicationReview: baseline.publicationReview,
    ownerPublicationReview: metadata(options.ownerReviewFile, ownerFile),
    templateFiles: [...templates].map(([file, value]) => metadata(file, value)),
    referenceReviewSha256: digest(JSON.stringify(references)),
    skill: metadata(skillPath, files.get(skillPath)), packageFingerprint: packageFingerprint(files),
    sectionMap: sections, teachingRuleMap: await teachingRuleMap(inputRoot, configuration, sections, owner),
    transformation: { reason: 'verbatim insertion; no pedagogy paraphrase', behavioralReview: 'PENDING' },
    representativeBehavior: { count: configuration.representativeBehavior.length,
      fieldSha256: baseline.configuration.fields.representativeBehavior.sha256 },
    compositionReview: { status: 'PENDING', approvedForRepository: false },
    limitations: ['Byte preservation does not establish teaching behavior, installed-client behavior, migration or release.',
      'Owner baseline approval is distinct from approval of this exact composed skill and package.',
      'Private teaching content is not approved for repository publication by composition.']
  };
  const reportContent = `${JSON.stringify(report, null, 2)}\n`;
  requireCondition(Buffer.byteLength(reportContent, 'utf8') <= maxFileSize, 'COMPOSITION_REPORT_TOO_LARGE');
  return { inputRoot, files, report, reportContent, references };
}

function safeSummary(prepared, relative) {
  const { report, reportContent, files } = prepared;
  return { sourceValidation: 'PASS', compositionStatus: report.status, outputDirectory: relative,
    baselineFingerprint: report.baselineFingerprint, configuration: report.configuration, skill: report.skill,
    packageFingerprint: report.packageFingerprint,
    report: { path: compositionReportPath, sha256: digest(reportContent), sizeBytes: Buffer.byteLength(reportContent, 'utf8') },
    sectionCount: report.sectionMap.length, teachingCategoryCount: report.teachingRuleMap.length,
    approvedRuleIds: [...new Set(report.teachingRuleMap.flatMap(item => item.approvedSourceIds))].sort(),
    representativeBehaviorCount: report.representativeBehavior.count,
    distributionFiles: [...files].map(([file, value]) => metadata(file, value)), ownerArtifactReview: 'PENDING' };
}

/** Writes only into a new, ignored private directory. Existing output is never overwritten. */
export async function composeTutorSkill(options) {
  const prepared = await prepare(options);
  const output = outputLocation(prepared.inputRoot, options.outputDirectory);
  await noSymlinkAncestors(path.dirname(output.absolute));
  await mkdir(output.absolute); // exclusive directory creation; never recursive over an existing output
  await noSymlinkAncestors(output.absolute);
  for (const [file, value] of prepared.files) {
    const destination = path.join(output.absolute, 'package', file);
    await mkdir(path.dirname(destination), { recursive: true });
    await noSymlinkAncestors(path.dirname(destination));
    await writeFile(destination, value.bytes, { flag: 'wx', mode: 0o600 });
  }
  await writeFile(path.join(output.absolute, compositionReportPath), prepared.reportContent, { flag: 'wx', mode: 0o600 });
  return safeSummary(prepared, output.relative);
}

/** Recompute expected bytes from approved sources, then inspect every private package byte and report. */
export async function inspectComposedTutorSkill(options) {
  const inputRoot = await privateRoot(options.inputRoot);
  const output = outputLocation(inputRoot, options.outputDirectory);
  const actualReport = await readSafeFile(output.absolute, compositionReportPath);
  const recorded = JSON.parse(actualReport.content);
  const prepared = await prepare({ ...options, ownerReviewFile: options.ownerReviewFile ?? recorded.ownerPublicationReview?.path });
  requireCondition(actualReport.content === prepared.reportContent, 'COMPOSITION_REPORT_CHANGED');
  const actualFiles = await packageFiles(path.join(output.absolute, 'package'), prepared.references.references);
  for (const [file, expected] of prepared.files) {
    requireCondition(actualFiles.get(file).bytes.equals(expected.bytes), 'COMPOSED_PACKAGE_BYTES_CHANGED');
  }
  requireCondition(options.expectedSkillSha256 === undefined || options.expectedSkillSha256 === prepared.report.skill.sha256,
    'EXPECTED_COMPOSED_SKILL_MISMATCH');
  requireCondition(options.expectedPackageFingerprint === undefined || options.expectedPackageFingerprint === prepared.report.packageFingerprint,
    'EXPECTED_COMPOSED_PACKAGE_MISMATCH');
  return safeSummary(prepared, output.relative);
}

export async function runCli() {
  const args = process.argv.slice(2);
  const options = {};
  let inspect = false;
  const flags = { '--inputs': 'inputRoot', '--baseline': 'baselineInventoryPath', '--template': 'templatePath',
    '--package': 'packageRoot', '--owner-review': 'ownerReviewFile', '--output': 'outputDirectory',
    '--references': 'referenceReviewPath' };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--inspect') inspect = true;
    else {
      const key = flags[args[index]];
      requireCondition(key && args[index + 1] && options[key] === undefined, 'UNSUPPORTED_ARGUMENT');
      options[key] = args[++index];
    }
  }
  requireCondition(options.inputRoot, 'PRIVATE_INPUT_ROOT_REQUIRED');
  const report = await (inspect ? inspectComposedTutorSkill(options) : composeTutorSkill(options));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(() => {
    process.stderr.write('COMPOSITION_INVALID: no private input contents or filesystem details are logged.\n');
    process.exitCode = 1;
  });
}
