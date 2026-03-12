#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';

import OpenAI from 'openai';

interface FineTuneComparisonCliOptions {
  jobId: string;
  validationJsonlPath: string;
  examplesToEvaluate: number;
  maxOutputTokens: number;
  temperature: number;
  outputPath: string;
  dryRun: boolean;
}

interface FineTuneComparisonExample {
  exampleIndex: number;
  promptMessages: Array<{ role: string; content: string }>;
  expectedAssistantContent: string;
}

interface CandidateModel {
  label: string;
  modelId: string;
  stepNumber: number;
  source: 'final' | 'checkpoint';
}

interface ComparisonScore {
  overlapF1: number;
  expectedTokenCount: number;
  actualTokenCount: number;
}

/**
 * Purpose: compare a succeeded fine-tuning run's final model against its checkpoints on held-out prompts.
 * Inputs/Outputs: job ID plus a validation JSONL path -> JSON report containing candidate models, raw outputs, and simple lexical scores.
 * Edge cases: dry-run mode avoids model calls; malformed validation rows fail fast so the comparison never mixes invalid prompts into the report.
 */
async function main(): Promise<void> {
  const options = parseCliArguments(process.argv.slice(2));
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  //audit Assumption: the comparison workflow requires authenticated access to both fine-tuning metadata and inference APIs; failure risk: a missing API key leads to confusing downstream HTTP errors; expected invariant: OPENAI_API_KEY is present before any remote call; handling strategy: stop immediately with a targeted error.
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required to compare fine-tuning checkpoints.');
  }

  const fineTuningJob = await client.fineTuning.jobs.retrieve(options.jobId);
  const checkpointPage = await client.fineTuning.jobs.checkpoints.list(options.jobId, { limit: 100 });
  const candidateModels = buildCandidateModels(fineTuningJob, checkpointPage.data);
  const validationExamples = await loadValidationExamples(
    options.validationJsonlPath,
    options.examplesToEvaluate
  );

  const reportBase = {
    generatedAt: new Date().toISOString(),
    jobId: fineTuningJob.id,
    jobStatus: fineTuningJob.status,
    fineTunedModel: fineTuningJob.fine_tuned_model,
    validationJsonlPath: options.validationJsonlPath,
    candidateModels,
    examplesRequested: options.examplesToEvaluate,
    examplesLoaded: validationExamples.length,
    inferenceConfig: {
      temperature: options.temperature,
      maxOutputTokens: options.maxOutputTokens
    }
  };

  //audit Assumption: dry-run mode is used to inspect configuration without incurring inference cost; failure risk: accidentally sampling models when the operator only wanted discovery; expected invariant: no responses API calls happen in dry-run mode; handling strategy: emit the report skeleton and return early.
  if (options.dryRun) {
    await writeJsonReport(options.outputPath, {
      ...reportBase,
      dryRun: true,
      results: []
    });
    console.log(`Dry-run report written to ${options.outputPath}`);
    return;
  }

  const comparisonResults = [];

  for (const validationExample of validationExamples) {
    const modelOutputs = [];

    for (const candidateModel of candidateModels) {
      const response = await client.responses.create({
        model: candidateModel.modelId,
        input: validationExample.promptMessages.map((message) => ({
          role: message.role as 'system' | 'developer' | 'user' | 'assistant',
          content: message.content
        })),
        temperature: options.temperature,
        max_output_tokens: options.maxOutputTokens,
        store: false
      });

      const actualOutput = response.output_text?.trim() ?? '';
      const comparisonScore = scoreAssistantOutput(
        validationExample.expectedAssistantContent,
        actualOutput
      );

      modelOutputs.push({
        ...candidateModel,
        actualOutput,
        comparisonScore,
        responseId: response.id
      });
    }

    comparisonResults.push({
      exampleIndex: validationExample.exampleIndex,
      promptMessages: validationExample.promptMessages,
      expectedAssistantContent: validationExample.expectedAssistantContent,
      modelOutputs
    });
  }

  const summaryByModel = candidateModels.map((candidateModel) => {
    const scores = comparisonResults
      .flatMap((result) => result.modelOutputs)
      .filter((output) => output.modelId === candidateModel.modelId)
      .map((output) => output.comparisonScore.overlapF1);

    return {
      ...candidateModel,
      examplesEvaluated: scores.length,
      averageOverlapF1: roundToFourDecimalPlaces(
        scores.reduce((total, score) => total + score, 0) / Math.max(scores.length, 1)
      )
    };
  });

  await writeJsonReport(options.outputPath, {
    ...reportBase,
    dryRun: false,
    summaryByModel,
    results: comparisonResults
  });

  console.log(`Comparison report written to ${options.outputPath}`);
}

/**
 * Purpose: parse CLI flags into a validated execution plan for checkpoint comparison.
 * Inputs/Outputs: raw CLI argument array -> normalized options object with defaults.
 * Edge cases: boolean flags are supported without a value; any malformed pair or missing required flag throws with a specific message.
 */
function parseCliArguments(rawArguments: string[]): FineTuneComparisonCliOptions {
  const argumentMap = new Map<string, string>();
  let dryRun = false;

  for (let index = 0; index < rawArguments.length; index += 1) {
    const rawArgument = rawArguments[index];

    if (rawArgument === '--dry-run') {
      dryRun = true;
      continue;
    }

    const value = rawArguments[index + 1];

    //audit Assumption: non-boolean flags must be provided as explicit key/value pairs; failure risk: silently shifting arguments would compare the wrong job or file; expected invariant: every non-boolean flag has a value; handling strategy: reject malformed CLI input immediately.
    if (!rawArgument?.startsWith('--') || value === undefined || value.startsWith('--')) {
      throw new Error(
        'Invalid arguments. Expected `--job-id <id>` and `--validation-jsonl <path>` pairs.'
      );
    }

    argumentMap.set(rawArgument, value);
    index += 1;
  }

  const jobId = argumentMap.get('--job-id');
  const validationJsonlPath = argumentMap.get('--validation-jsonl');

  if (!jobId) {
    throw new Error('Missing required flag: --job-id <fine-tuning-job-id>');
  }

  if (!validationJsonlPath) {
    throw new Error('Missing required flag: --validation-jsonl <path-to-validation-jsonl>');
  }

  const defaultOutputPath = join(
    process.cwd(),
    'output',
    'fine-tune-comparisons',
    `${sanitizeFileStem(jobId)}.json`
  );

  return {
    jobId,
    validationJsonlPath: resolve(validationJsonlPath),
    examplesToEvaluate: parsePositiveIntegerFlag('--examples', argumentMap.get('--examples') ?? '5'),
    maxOutputTokens: parsePositiveIntegerFlag(
      '--max-output-tokens',
      argumentMap.get('--max-output-tokens') ?? '400'
    ),
    temperature: parseNumericFlag('--temperature', argumentMap.get('--temperature') ?? '0'),
    outputPath: resolve(argumentMap.get('--output') ?? defaultOutputPath),
    dryRun
  };
}

/**
 * Purpose: construct the set of models to compare from the final fine-tuned model and all checkpoints.
 * Inputs/Outputs: fine-tuning job plus checkpoint list -> sorted comparison candidates.
 * Edge cases: the final model must exist for a succeeded review; missing final models fail fast instead of producing a misleading checkpoint-only report.
 */
function buildCandidateModels(
  fineTuningJob: OpenAI.FineTuning.Jobs.FineTuningJob,
  checkpoints: OpenAI.FineTuning.Jobs.Checkpoints.FineTuningJobCheckpoint[]
): CandidateModel[] {
  //audit Assumption: comparison against the shipped model only makes sense after a successful fine-tuning run; failure risk: pending or failed jobs would leave the final model undefined and hide operator error; expected invariant: a finished comparison target has a fine_tuned_model ID; handling strategy: require the final model ID before building candidates.
  if (!fineTuningJob.fine_tuned_model) {
    throw new Error(`Fine-tuning job ${fineTuningJob.id} does not have a fine_tuned_model yet.`);
  }

  const sortedCheckpoints = [...checkpoints].sort(
    (leftCheckpoint, rightCheckpoint) => leftCheckpoint.step_number - rightCheckpoint.step_number
  );

  const checkpointCandidates = sortedCheckpoints
    .filter(
      (checkpoint) => checkpoint.fine_tuned_model_checkpoint !== fineTuningJob.fine_tuned_model
    )
    .map((checkpoint) => ({
      label: `checkpoint-step-${checkpoint.step_number}`,
      modelId: checkpoint.fine_tuned_model_checkpoint,
      stepNumber: checkpoint.step_number,
      source: 'checkpoint' as const
    }));

  return [
    ...checkpointCandidates,
    {
      label: 'final-model',
      modelId: fineTuningJob.fine_tuned_model,
      stepNumber: sortedCheckpoints.at(-1)?.step_number ?? 0,
      source: 'final' as const
    }
  ];
}

/**
 * Purpose: load validation examples and isolate the prompt-side messages from the expected assistant answer.
 * Inputs/Outputs: validation JSONL path and requested example count -> normalized comparison examples.
 * Edge cases: rows without a final assistant turn are rejected so the script never evaluates prompts without a ground-truth answer.
 */
async function loadValidationExamples(
  validationJsonlPath: string,
  examplesToEvaluate: number
): Promise<FineTuneComparisonExample[]> {
  const rawJsonl = await readFile(validationJsonlPath, 'utf8');
  const rows = rawJsonl
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0);

  const comparisonExamples = rows.slice(0, examplesToEvaluate).map((row, exampleIndex) => {
    const parsedRow = JSON.parse(row) as { messages?: Array<{ role: string; content: string }> };
    const parsedMessages = parsedRow.messages ?? [];
    const lastMessage = parsedMessages.at(-1);

    //audit Assumption: supervised fine-tuning examples must end with the target assistant reply; failure risk: comparing on malformed rows would score the wrong text and invalidate the review; expected invariant: each selected row ends with an assistant message; handling strategy: reject the file as malformed when that invariant is broken.
    if (!lastMessage || lastMessage.role !== 'assistant') {
      throw new Error(
        `Validation example ${exampleIndex + 1} in ${validationJsonlPath} does not end with an assistant message.`
      );
    }

    const promptMessages = parsedMessages.slice(0, -1);

    return {
      exampleIndex,
      promptMessages,
      expectedAssistantContent: lastMessage.content
    };
  });

  return comparisonExamples;
}

/**
 * Purpose: compute a light-weight lexical similarity score for quick checkpoint triage.
 * Inputs/Outputs: expected and actual assistant strings -> overlap score and token counts.
 * Edge cases: empty outputs score as zero without throwing so failed generations remain visible in the report.
 */
function scoreAssistantOutput(expectedAssistantContent: string, actualAssistantContent: string): ComparisonScore {
  const expectedTokens = tokenizeComparisonText(expectedAssistantContent);
  const actualTokens = tokenizeComparisonText(actualAssistantContent);

  //audit Assumption: lexical overlap is only a cheap proxy for quality, not a semantic judge; failure risk: over-trusting this number would hide stylistic or factual regressions; expected invariant: the score is used for triage alongside raw outputs; handling strategy: keep the metric simple and emit raw outputs for human review.
  if (expectedTokens.length === 0 || actualTokens.length === 0) {
    return {
      overlapF1: 0,
      expectedTokenCount: expectedTokens.length,
      actualTokenCount: actualTokens.length
    };
  }

  const expectedTokenSet = new Set(expectedTokens);
  const actualTokenSet = new Set(actualTokens);
  const overlappingTokenCount = [...actualTokenSet].filter((token) => expectedTokenSet.has(token)).length;
  const precision = overlappingTokenCount / actualTokenSet.size;
  const recall = overlappingTokenCount / expectedTokenSet.size;
  const overlapF1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    overlapF1: roundToFourDecimalPlaces(overlapF1),
    expectedTokenCount: expectedTokens.length,
    actualTokenCount: actualTokens.length
  };
}

function tokenizeComparisonText(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

function roundToFourDecimalPlaces(value: number): number {
  return Number(value.toFixed(4));
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

  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    throw new Error(`${flagName} must be a positive integer. Received: ${rawValue}`);
  }

  return parsedValue;
}

async function writeJsonReport(outputPath: string, report: unknown): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
}

main().catch((error) => {
  //audit Assumption: comparison setup failures should fail loudly before operators trust an incomplete report; failure risk: partial or stale output hides missing checkpoints or malformed validation rows; expected invariant: command exits non-zero on any setup or inference failure; handling strategy: print the concrete error and propagate a failing exit code.
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
