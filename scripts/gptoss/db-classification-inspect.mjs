#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPORT_PATH = 'local_artifacts/gptoss-db-governance/classification-coverage-report.json';
const DEFAULT_MAPPING_PATH = 'local_artifacts/gptoss-db-governance/self-reflection-candidate-mapping-plan.json';
const LOCAL_SCHEMA_PATHS = [
  'src/core/db/schema.ts',
  'migrations/20260521_gptoss_governance.sql',
];

const DATASET_TABLE_PATTERNS = [
  /^gptoss_/,
  /^self_reflections$/,
  /^chat_messages$/,
  /^rag_docs$/,
  /^job_data$/,
  /^execution_logs$/,
  /^audit_logs$/,
  /^saves$/,
];

const TRAINING_CLASSIFICATION_FIELDS = [
  'source',
  'reviewed',
  'redacted',
  'allowed_for_training',
  'requires_human_review',
  'no_openai_output_used',
  'target_shape',
  'task_type',
];

const SAFETY_FLAGS = {
  allowedForTraining: false,
  openAiCalled: false,
  trainingExecuted: false,
  vllmUsed: false,
  railwayCliExecuted: false,
  rawContentDumped: false,
  rawRowsDumped: false,
  trainingJsonlExported: false,
  noOpenAiOutputUsed: true,
};

export function parseArgs(argv = []) {
  const options = {
    execute: false,
    report: DEFAULT_REPORT_PATH,
    mappingReport: DEFAULT_MAPPING_PATH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = argv[index + 1];
    if (flag === '--execute') {
      options.execute = true;
    } else if (flag === '--report' && next) {
      options.report = next;
      index += 1;
    } else if (flag === '--mapping-report' && next) {
      options.mappingReport = next;
      index += 1;
    }
  }

  return options;
}

function readLocalSchemaText(paths = LOCAL_SCHEMA_PATHS) {
  return paths
    .filter((path) => existsSync(path))
    .map((path) => readFileSync(path, 'utf8'))
    .join('\n');
}

function extractColumnNames(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ''))
    .filter((line) => line.length > 0)
    .filter((line) => !/^(CONSTRAINT|PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i.test(line))
    .map((line) => line.match(/^"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+/)?.[1])
    .filter(Boolean);
}

export function extractTableColumns(schemaText) {
  const tables = {};
  const lines = schemaText.split(/\r?\n/);
  let tableName = null;
  let body = [];

  for (const line of lines) {
    const start = line.match(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/i);
    if (!tableName && start) {
      tableName = start[1];
      body = [];
      continue;
    }

    if (tableName && /^\s*\)\s*[,;`]/.test(line)) {
      tables[tableName] = extractColumnNames(body.join('\n'));
      tableName = null;
      body = [];
      continue;
    }

    if (tableName) {
      body.push(line);
    }
  }
  return tables;
}

function isDatasetLikeTable(tableName) {
  return DATASET_TABLE_PATTERNS.some((pattern) => pattern.test(tableName));
}

function summarizeDatasetTables(tables) {
  const datasetTablesFound = Object.keys(tables)
    .filter(isDatasetLikeTable)
    .sort()
    .map((tableName) => ({
      tableName,
      columns: tables[tableName],
    }));

  const datasetClassificationFieldsFound = {};
  const missingClassificationFields = {};
  for (const table of datasetTablesFound) {
    const fields = TRAINING_CLASSIFICATION_FIELDS.filter((field) => table.columns.includes(field));
    const missing = TRAINING_CLASSIFICATION_FIELDS.filter((field) => !table.columns.includes(field));
    datasetClassificationFieldsFound[table.tableName] = fields;
    missingClassificationFields[table.tableName] = missing;
  }

  return {
    datasetTablesFound,
    datasetClassificationFieldsFound,
    missingClassificationFields,
  };
}

function aggregateCounts(rows, fieldName) {
  const counts = new Map();
  for (const row of rows) {
    const key = row[fieldName] ?? 'unclassified';
    counts.set(key, (counts.get(key) ?? 0) + Number(row.count ?? 0));
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ [fieldName]: value, count }))
    .sort((left, right) => right.count - left.count || String(left[fieldName]).localeCompare(String(right[fieldName])));
}

async function inspectLiveDatabase() {
  if (typeof process.env.DATABASE_URL !== 'string' || process.env.DATABASE_URL.trim().length === 0) {
    throw new Error('required_db_connection_env_missing');
  }

  const { Pool } = await import('pg');
  const pool = new Pool();
  try {
    const tablesResult = await pool.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
       ORDER BY table_name`,
    );
    const tableNames = tablesResult.rows.map((row) => row.table_name);
    const columnsResult = await pool.query(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
       ORDER BY table_name, ordinal_position`,
    );
    const tables = {};
    for (const row of columnsResult.rows) {
      tables[row.table_name] ??= [];
      tables[row.table_name].push(row.column_name);
    }

    const selfReflectionsTableExists = tableNames.includes('self_reflections');
    let selfReflectionRowCount = null;
    let categoryPriorityCounts = [];
    let metadataKeys = [];

    if (selfReflectionsTableExists) {
      const countResult = await pool.query('SELECT COUNT(*)::int AS count FROM self_reflections');
      selfReflectionRowCount = countResult.rows[0]?.count ?? 0;

      const categoryPriorityResult = await pool.query(
        `SELECT category, priority, COUNT(*)::int AS count
         FROM self_reflections
         GROUP BY category, priority
         ORDER BY count DESC, category ASC, priority ASC`,
      );
      categoryPriorityCounts = categoryPriorityResult.rows;

      const metadataKeysResult = await pool.query(
        `SELECT key, COUNT(*)::int AS count
         FROM self_reflections, LATERAL jsonb_object_keys(metadata) AS key
         GROUP BY key
         ORDER BY count DESC, key ASC`,
      );
      metadataKeys = metadataKeysResult.rows;
    }

    return {
      tables,
      selfReflectionsTableExists,
      selfReflectionRowCount,
      categoryCounts: aggregateCounts(categoryPriorityCounts, 'category'),
      priorityCounts: aggregateCounts(categoryPriorityCounts, 'priority'),
      categoryPriorityCounts,
      metadataKeys,
      liveDbConnected: true,
    };
  } finally {
    await pool.end();
  }
}

export async function buildClassificationInspection(options = {}) {
  const schemaText = readLocalSchemaText();
  const localTables = extractTableColumns(schemaText);
  let tables = localTables;
  let live = {
    selfReflectionsTableExists: Object.hasOwn(localTables, 'self_reflections'),
    selfReflectionRowCount: null,
    categoryCounts: [],
    priorityCounts: [],
    categoryPriorityCounts: [],
    metadataKeys: [],
    liveDbConnected: false,
  };
  const errors = [];

  if (options.execute) {
    try {
      live = await inspectLiveDatabase();
      tables = live.tables;
    } catch (error) {
      errors.push({
        code: error instanceof Error ? error.message : 'classification_inspection_failed',
      });
    }
  }

  const datasetSummary = summarizeDatasetTables(tables);
  const selfReflectionColumns = tables.self_reflections ?? [];

  return {
    ok: errors.length === 0,
    mode: options.execute ? 'live_metadata_only' : 'dry_run_local_schema_only',
    selfReflectionsTableExists: live.selfReflectionsTableExists,
    selfReflectionColumns,
    selfReflectionHasCategoryPriority:
      selfReflectionColumns.includes('category') && selfReflectionColumns.includes('priority'),
    selfReflectionRowCount: live.selfReflectionRowCount,
    categoryCounts: live.categoryCounts,
    priorityCounts: live.priorityCounts,
    categoryPriorityCounts: live.categoryPriorityCounts,
    metadataKeys: live.metadataKeys,
    ...datasetSummary,
    safeCandidatePathRecommended: true,
    reportNotes: [
      'self_reflections content is not selected or exported',
      'metadata inspection counts keys only',
      'self_reflection_observation remains candidate-only and not trainable',
    ],
    ...SAFETY_FLAGS,
    liveDbConnected: live.liveDbConnected,
    errors,
  };
}

export function buildSelfReflectionCandidateMappingPlan({ metadataKeys = [] } = {}) {
  const metadataKeyNames = metadataKeys.map((entry) => entry.key).filter(Boolean).sort();
  return {
    ok: true,
    sourceTable: 'self_reflections',
    candidateDefaults: {
      source: 'self_reflection_observation',
      reviewed: false,
      allowed_for_training: false,
      requires_human_review: true,
    },
    categoryToTaskTypeCandidate: {
      routing: 'label_only',
      safety: 'compact_final',
      control_boundary: 'compact_final',
      data_governance: 'json_only',
      dataset: 'json_only',
      evaluation: 'compact_final',
      judged_response: 'compact_final',
      architecture: 'compact_final',
      default: 'compact_final',
    },
    priorityToReviewPriority: {
      critical: 'high',
      high: 'high',
      medium: 'normal',
      normal: 'normal',
      low: 'backlog',
      default: 'normal',
    },
    metadataKeys: metadataKeyNames,
    metadataValuesIncluded: false,
    metadataValuePolicy: 'keys_only_values_never_exported',
    approvedConversionPath: [
      'inspect schema and aggregate counts only',
      'select candidate identifiers for human review without dumping content',
      'rewrite safe examples as human_authored, arcanos_owned_spec, or repo_schema',
      'redact and review before allowed_for_training can become true',
      'run dataset gate before any export',
    ],
    ...SAFETY_FLAGS,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await buildClassificationInspection(options);
  const mappingPlan = buildSelfReflectionCandidateMappingPlan({ metadataKeys: report.metadataKeys });
  writeJson(options.report, report);
  writeJson(options.mappingReport, mappingPlan);
  const output = {
    ...report,
    reportPath: options.report,
    mappingReportPath: options.mappingReport,
  };
  console.log(JSON.stringify(output, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((status) => process.exit(status)).catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'classification_inspection_failed',
      ...SAFETY_FLAGS,
    }, null, 2));
    process.exit(1);
  });
}
