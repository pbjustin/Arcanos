#!/usr/bin/env node

import { mkdir, writeFile } from 'fs/promises';
import { basename, extname, join, resolve } from 'path';

import yauzl from 'yauzl';

import {
  buildFineTuneDataset,
  serializeExamplesToJsonl,
  serializeIndexToJsonl
} from '../src/training/openaiFineTuneDataset.ts';

interface CliOptions {
  zipPath: string;
  outputDirectory: string;
  validationRatio: number;
  splitSeed: string;
  maxMessagesPerExample: number;
  minimumAssistantCharacters: number;
}

/**
 * Purpose: convert a ChatGPT export ZIP into OpenAI supervised fine-tuning JSONL datasets.
 * Inputs/Outputs: CLI flags and a ZIP archive path -> JSONL datasets, index sidecars, and a report.
 * Edge cases: missing conversation shards or invalid JSON fail fast with explicit errors before any partial write is reported as successful.
 */
async function main(): Promise<void> {
  const options = parseCliArguments(process.argv.slice(2));
  const conversationShardNames = await listConversationShardNames(options.zipPath);

  //audit Assumption: a valid ChatGPT export must include at least one `conversations*.json` shard; failure risk: producing empty files from the wrong archive hides operator mistakes; expected invariant: the archive contains conversation data; handling strategy: stop immediately when no shard files are found.
  if (conversationShardNames.length === 0) {
    throw new Error(`No conversations JSON shards were found in ${options.zipPath}`);
  }

  const allConversations: Parameters<typeof buildFineTuneDataset>[0] = [];

  for (const shardName of conversationShardNames) {
    const shardText = await readArchiveEntryText(options.zipPath, shardName);
    const parsedShard = JSON.parse(shardText);

    if (!Array.isArray(parsedShard)) {
      throw new Error(`Expected ${shardName} to contain a JSON array.`);
    }

    allConversations.push(...parsedShard);
  }

  const dataset = buildFineTuneDataset(allConversations, {
    validationRatio: options.validationRatio,
    splitSeed: options.splitSeed,
    maxMessagesPerExample: options.maxMessagesPerExample,
    minimumAssistantCharacters: options.minimumAssistantCharacters
  });

  await mkdir(options.outputDirectory, { recursive: true });

  const allJsonlPath = join(options.outputDirectory, 'all.jsonl');
  const allIndexPath = join(options.outputDirectory, 'all.index.jsonl');
  const trainJsonlPath = join(options.outputDirectory, 'train.jsonl');
  const trainIndexPath = join(options.outputDirectory, 'train.index.jsonl');
  const validationJsonlPath = join(options.outputDirectory, 'validation.jsonl');
  const validationIndexPath = join(options.outputDirectory, 'validation.index.jsonl');
  const reportPath = join(options.outputDirectory, 'report.json');

  await Promise.all([
    writeFile(allJsonlPath, withTrailingNewline(serializeExamplesToJsonl(dataset.allExamples)), 'utf8'),
    writeFile(allIndexPath, withTrailingNewline(serializeIndexToJsonl(dataset.allExamples)), 'utf8'),
    writeFile(trainJsonlPath, withTrailingNewline(serializeExamplesToJsonl(dataset.trainExamples)), 'utf8'),
    writeFile(trainIndexPath, withTrailingNewline(serializeIndexToJsonl(dataset.trainExamples)), 'utf8'),
    writeFile(
      validationJsonlPath,
      withTrailingNewline(serializeExamplesToJsonl(dataset.validationExamples)),
      'utf8'
    ),
    writeFile(
      validationIndexPath,
      withTrailingNewline(serializeIndexToJsonl(dataset.validationExamples)),
      'utf8'
    ),
    writeFile(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          sourceArchivePath: options.zipPath,
          outputDirectory: options.outputDirectory,
          conversationShardNames,
          options: {
            validationRatio: options.validationRatio,
            splitSeed: options.splitSeed,
            maxMessagesPerExample: options.maxMessagesPerExample,
            minimumAssistantCharacters: options.minimumAssistantCharacters
          },
          summary: dataset.summary
        },
        null,
        2
      ),
      'utf8'
    )
  ]);

  console.log(`Built ${dataset.summary.examplesBuilt} examples from ${dataset.summary.conversationsWithExamples} conversations.`);
  console.log(`Train: ${dataset.summary.trainExamples} -> ${trainJsonlPath}`);
  console.log(`Validation: ${dataset.summary.validationExamples} -> ${validationJsonlPath}`);
  console.log(`Report: ${reportPath}`);
}

function parseCliArguments(rawArguments: string[]): CliOptions {
  const argumentMap = new Map<string, string>();

  for (let index = 0; index < rawArguments.length; index += 2) {
    const key = rawArguments[index];
    const value = rawArguments[index + 1];

    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(
        'Invalid arguments. Expected pairs like `--zip <path>` and `--output-dir <path>`.'
      );
    }

    argumentMap.set(key, value);
  }

  const zipPath = argumentMap.get('--zip');

  if (!zipPath) {
    throw new Error('Missing required flag: --zip <path-to-chatgpt-export.zip>');
  }

  const resolvedZipPath = resolve(zipPath);
  const defaultOutputDirectory = join(
    process.cwd(),
    'output',
    'fine-tune',
    sanitizeFileStem(basename(resolvedZipPath, extname(resolvedZipPath)))
  );

  return {
    zipPath: resolvedZipPath,
    outputDirectory: resolve(argumentMap.get('--output-dir') ?? defaultOutputDirectory),
    validationRatio: parseNumericFlag('--validation-ratio', argumentMap.get('--validation-ratio') ?? '0.1'),
    splitSeed: argumentMap.get('--split-seed') ?? basename(resolvedZipPath),
    maxMessagesPerExample: parsePositiveIntegerFlag('--max-messages', argumentMap.get('--max-messages') ?? '12'),
    minimumAssistantCharacters: parseNonNegativeIntegerFlag(
      '--minimum-assistant-characters',
      argumentMap.get('--minimum-assistant-characters') ?? '8'
    )
  };
}

function sanitizeFileStem(fileStem: string): string {
  return fileStem.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-');
}

function parseNumericFlag(flagName: string, rawValue: string): number {
  const parsedValue = Number(rawValue);

  if (!Number.isFinite(parsedValue)) {
    throw new Error(`${flagName} must be a finite number. Received: ${rawValue}`);
  }

  return parsedValue;
}

function parsePositiveIntegerFlag(flagName: string, rawValue: string): number {
  const parsedValue = parseNumericFlag(flagName, rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 2) {
    throw new Error(`${flagName} must be an integer greater than or equal to 2. Received: ${rawValue}`);
  }

  return parsedValue;
}

function parseNonNegativeIntegerFlag(flagName: string, rawValue: string): number {
  const parsedValue = parseNumericFlag(flagName, rawValue);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${flagName} must be a non-negative integer. Received: ${rawValue}`);
  }

  return parsedValue;
}

async function listConversationShardNames(zipPath: string): Promise<string[]> {
  const archiveEntries = await listArchiveEntries(zipPath);
  return archiveEntries
    .filter((entryName) => /^conversations(?:-\d{3})?\.json$/i.test(entryName))
    .sort();
}

async function listArchiveEntries(zipPath: string): Promise<string[]> {
  const archive = await openZipArchive(zipPath);
  const entryNames: string[] = [];

  return new Promise((resolvePromise, rejectPromise) => {
    const finalize = (callback: () => void) => {
      archive.close();
      callback();
    };

    archive.on('entry', (entry) => {
      entryNames.push(entry.fileName);
      archive.readEntry();
    });

    archive.on('end', () => finalize(() => resolvePromise(entryNames)));

    archive.on('error', (error) => finalize(() => rejectPromise(error)));

    archive.readEntry();
  });
}

async function readArchiveEntryText(zipPath: string, targetEntryName: string): Promise<string> {
  const archive = await openZipArchive(zipPath);

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      archive.close();
      callback();
    };

    archive.on('entry', (entry) => {
      if (settled) {
        return;
      }

      if (entry.fileName !== targetEntryName) {
        archive.readEntry();
        return;
      }

      archive.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          settle(() =>
            rejectPromise(error ?? new Error(`Unable to open archive entry: ${targetEntryName}`))
          );
          return;
        }

        const chunks: Buffer[] = [];

        stream.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        stream.on('error', (streamError) => settle(() => rejectPromise(streamError)));
        stream.on('end', () =>
          settle(() => resolvePromise(Buffer.concat(chunks).toString('utf8')))
        );
      });
    });

    archive.on('end', () =>
      settle(() => rejectPromise(new Error(`Archive entry not found: ${targetEntryName}`)))
    );

    archive.on('error', (error) => settle(() => rejectPromise(error)));

    archive.readEntry();
  });
}

async function openZipArchive(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, rejectPromise) => {
    yauzl.open(zipPath, { lazyEntries: true }, (error, archive) => {
      if (error || !archive) {
        rejectPromise(error ?? new Error(`Unable to open ZIP archive: ${zipPath}`));
        return;
      }

      resolvePromise(archive);
    });
  });
}

function withTrailingNewline(content: string): string {
  return content.length === 0 ? '' : `${content}\n`;
}

main().catch((error) => {
  //audit Assumption: dataset generation failures should stop the command before users rely on partial outputs; failure risk: silent or ambiguous failures lead to uploading incomplete training files; expected invariant: failures exit non-zero with a clear message; handling strategy: print the error and set `process.exitCode` so shell automation can detect the failure.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
