import {
  Ajv,
  type ErrorObject,
  type ValidateFunction
} from 'ajv';

import type {
  ModuleActionMetadata,
  ModuleActionRisk
} from '../moduleLoader.js';

export const LOCAL_AGENT_MODULE_NAME = 'ARCANOS:LOCAL_AGENT';

export const LOCAL_AGENT_ACTIONS = [
  'local_agent.status',
  'repo.search',
  'git.status',
  'git.diff',
  'tests.run',
  'patch.preview',
  'patch.apply'
] as const;

export const LOCAL_AGENT_TEST_PROFILES = [
  'python-unit',
  'typescript-unit',
  'typescript-integration',
  'backend-cli-contract'
] as const;

export type LocalAgentAction = (typeof LOCAL_AGENT_ACTIONS)[number];
export type LocalAgentTestProfile = (typeof LOCAL_AGENT_TEST_PROFILES)[number];
export type LocalAgentJsonSchema = Record<string, unknown>;

export interface LocalAgentActionInputMap {
  'local_agent.status': Record<string, never>;
  'repo.search': {
    query: string;
    options?: {
      type?: 'text' | 'symbol';
      path?: string;
      includeHidden?: boolean;
      offset?: number;
      limit?: number;
      maxFileBytes?: number;
    };
  };
  'git.status': Record<string, never>;
  'git.diff': {
    base: string;
    head: string;
    contextLines?: number;
    maxBytes?: number;
  };
  'tests.run': {
    profile: LocalAgentTestProfile;
  };
  'patch.preview': {
    patch: string;
  };
  'patch.apply': {
    patch: string;
    expectedPatchSha256: string;
  };
}

export interface LocalAgentActionOutputMap {
  'local_agent.status': {
    status: 'ready' | 'busy' | 'degraded';
    daemonVersion: string;
    capabilities: LocalAgentAction[];
    workspaceRegistered: boolean;
    testExecutionMode:
      | 'disabled'
      | 'sandboxed'
      | 'unsandboxed-development-only';
    testSandboxAvailable: boolean;
    testSandboxRuntime: 'docker' | 'podman' | null;
    observedAt: string;
  };
  'repo.search': {
    query: string;
    searchType: 'text' | 'symbol';
    offset: number;
    limit: number;
    nextOffset?: number;
    searchedFileCount: number;
    matches: Array<{
      path: string;
      line: number;
      column: number;
      preview: string;
      symbolKind?: string;
    }>;
    truncated: boolean;
  };
  'git.status': {
    branch?: string;
    head?: string;
    clean: boolean;
    changes: Array<{
      path: string;
      indexStatus: string;
      workTreeStatus: string;
      originalPath?: string;
    }>;
    gitAvailable: boolean;
    workspaceType: 'git' | 'deployed-artifact';
    message?: string;
  };
  'git.diff': {
    base: string;
    head: string;
    diff: string;
    bytes: number;
    truncated: boolean;
  };
  'tests.run': {
    profile: LocalAgentTestProfile;
    status: 'passed' | 'failed' | 'timed_out';
    exitCode: number | null;
    stdout: string;
    stderr: string;
    durationMs: number;
    truncated: boolean;
  };
  'patch.preview': {
    patchSha256: string;
    files: string[];
    applicable: boolean;
    check: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
    };
  };
  'patch.apply': {
    patchSha256: string;
    files: string[];
    applied: true;
  };
}

export interface LocalAgentCapabilityContract {
  id: LocalAgentAction;
  description: string;
  executionTarget: 'python-daemon';
  inputSchema: LocalAgentJsonSchema;
  outputSchema: LocalAgentJsonSchema;
  risk: ModuleActionRisk;
  requiresConfirmation: boolean;
  idempotent: boolean;
  timeoutMs: number;
  requiredDeviceScopes: string[];
  readOnly: boolean;
  mayModifyFiles: boolean;
}

const objectSchema = (
  properties: Record<string, unknown> = {},
  required: string[] = []
): LocalAgentJsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const boundedStringSchema = (
  maxLength: number,
  extra: Record<string, unknown> = {}
): LocalAgentJsonSchema => ({
  type: 'string',
  minLength: 1,
  maxLength,
  ...extra
});

const relativePathSchema = boundedStringSchema(1_024, {
  pattern:
    '^(?![A-Za-z]:[\\\\/])(?![\\\\/])(?!.*(?:^|[\\\\/])\\.\\.(?:[\\\\/]|$)).+$'
});
const gitRefSchema = boundedStringSchema(200, {
  pattern: '^(?!-)(?!.*(?:\\.\\.|@\\{|[~^:?*\\[\\\\\\s]))[A-Za-z0-9][A-Za-z0-9._/-]*$'
});
const patchSchema = boundedStringSchema(200_000, {
  pattern: '\\S',
  maxUtf8Bytes: 200_000
});
const sha256Schema = {
  type: 'string',
  pattern: '^[A-Fa-f0-9]{64}$'
};
const outputTextSchema = {
  type: 'string',
  maxLength: 65_536
};
const outputPathSchema = boundedStringSchema(1_024);
const nullableExitCodeSchema = {
  type: ['integer', 'null'],
  minimum: -2_147_483_648,
  maximum: 2_147_483_647
};

export const LOCAL_AGENT_ACTION_INPUT_SCHEMAS: Readonly<
  Record<LocalAgentAction, LocalAgentJsonSchema>
> = {
  'local_agent.status': objectSchema(),
  'repo.search': objectSchema({
    query: boundedStringSchema(1_000, { pattern: '\\S' }),
    options: objectSchema({
      type: {
        type: 'string',
        enum: ['text', 'symbol'],
        default: 'text'
      },
      path: relativePathSchema,
      includeHidden: {
        type: 'boolean',
        default: false
      },
      offset: {
        type: 'integer',
        minimum: 0,
        maximum: 10_000,
        default: 0
      },
      limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        default: 50
      },
      maxFileBytes: {
        type: 'integer',
        minimum: 1,
        maximum: 1_048_576,
        default: 262_144
      }
    })
  }, ['query']),
  'git.status': objectSchema(),
  'git.diff': objectSchema({
    base: gitRefSchema,
    head: gitRefSchema,
    contextLines: {
      type: 'integer',
      minimum: 0,
      maximum: 20,
      default: 3
    },
    maxBytes: {
      type: 'integer',
      minimum: 1,
      maximum: 65_536,
      default: 32_768
    }
  }, ['base', 'head']),
  'tests.run': objectSchema({
    profile: {
      type: 'string',
      enum: LOCAL_AGENT_TEST_PROFILES
    }
  }, ['profile']),
  'patch.preview': objectSchema({
    patch: patchSchema
  }, ['patch']),
  'patch.apply': objectSchema({
    patch: patchSchema,
    expectedPatchSha256: sha256Schema
  }, ['patch', 'expectedPatchSha256'])
};

export const LOCAL_AGENT_ACTION_OUTPUT_SCHEMAS: Readonly<
  Record<LocalAgentAction, LocalAgentJsonSchema>
> = {
  'local_agent.status': objectSchema({
    status: {
      type: 'string',
      enum: ['ready', 'busy', 'degraded']
    },
    daemonVersion: boundedStringSchema(120),
    capabilities: {
      type: 'array',
      items: {
        type: 'string',
        enum: LOCAL_AGENT_ACTIONS
      },
      uniqueItems: true,
      maxItems: LOCAL_AGENT_ACTIONS.length
    },
    workspaceRegistered: {
      type: 'boolean'
    },
    testExecutionMode: {
      type: 'string',
      enum: [
        'disabled',
        'sandboxed',
        'unsandboxed-development-only'
      ]
    },
    testSandboxAvailable: {
      type: 'boolean'
    },
    testSandboxRuntime: {
      type: ['string', 'null'],
      enum: ['docker', 'podman', null]
    },
    observedAt: boundedStringSchema(64)
  }, [
    'status',
    'daemonVersion',
    'capabilities',
    'workspaceRegistered',
    'testExecutionMode',
    'testSandboxAvailable',
    'testSandboxRuntime',
    'observedAt'
  ]),
  'repo.search': objectSchema({
    query: boundedStringSchema(1_000),
    searchType: {
      type: 'string',
      enum: ['text', 'symbol']
    },
    offset: {
      type: 'integer',
      minimum: 0
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 200
    },
    nextOffset: {
      type: 'integer',
      minimum: 0
    },
    searchedFileCount: {
      type: 'integer',
      minimum: 0
    },
    matches: {
      type: 'array',
      maxItems: 200,
      items: objectSchema({
        path: outputPathSchema,
        line: {
          type: 'integer',
          minimum: 1
        },
        column: {
          type: 'integer',
          minimum: 1
        },
        preview: {
          type: 'string',
          maxLength: 240
        },
        symbolKind: boundedStringSchema(80)
      }, ['path', 'line', 'column', 'preview'])
    },
    truncated: {
      type: 'boolean'
    }
  }, [
    'query',
    'searchType',
    'offset',
    'limit',
    'searchedFileCount',
    'matches',
    'truncated'
  ]),
  'git.status': objectSchema({
    branch: boundedStringSchema(512),
    head: boundedStringSchema(128),
    clean: {
      type: 'boolean'
    },
    changes: {
      type: 'array',
      maxItems: 10_000,
      items: objectSchema({
        path: outputPathSchema,
        indexStatus: boundedStringSchema(1),
        workTreeStatus: boundedStringSchema(1),
        originalPath: outputPathSchema
      }, ['path', 'indexStatus', 'workTreeStatus'])
    },
    gitAvailable: {
      type: 'boolean'
    },
    workspaceType: {
      type: 'string',
      enum: ['git', 'deployed-artifact']
    },
    message: {
      type: 'string',
      maxLength: 1_000
    }
  }, ['clean', 'changes', 'gitAvailable', 'workspaceType']),
  'git.diff': objectSchema({
    base: boundedStringSchema(200),
    head: boundedStringSchema(200),
    diff: {
      type: 'string',
      maxLength: 65_536
    },
    bytes: {
      type: 'integer',
      minimum: 0,
      maximum: 65_536
    },
    truncated: {
      type: 'boolean'
    }
  }, ['base', 'head', 'diff', 'bytes', 'truncated']),
  'tests.run': objectSchema({
    profile: {
      type: 'string',
      enum: LOCAL_AGENT_TEST_PROFILES
    },
    status: {
      type: 'string',
      enum: ['passed', 'failed', 'timed_out']
    },
    exitCode: nullableExitCodeSchema,
    stdout: outputTextSchema,
    stderr: outputTextSchema,
    durationMs: {
      type: 'integer',
      minimum: 0,
      maximum: 900_000
    },
    truncated: {
      type: 'boolean'
    }
  }, [
    'profile',
    'status',
    'exitCode',
    'stdout',
    'stderr',
    'durationMs',
    'truncated'
  ]),
  'patch.preview': objectSchema({
    patchSha256: sha256Schema,
    files: {
      type: 'array',
      items: outputPathSchema,
      uniqueItems: true,
      maxItems: 1_000
    },
    applicable: {
      type: 'boolean'
    },
    check: objectSchema({
      exitCode: nullableExitCodeSchema,
      stdout: outputTextSchema,
      stderr: outputTextSchema,
      truncated: {
        type: 'boolean'
      }
    }, ['exitCode', 'stdout', 'stderr', 'truncated'])
  }, ['patchSha256', 'files', 'applicable', 'check']),
  'patch.apply': objectSchema({
    patchSha256: sha256Schema,
    files: {
      type: 'array',
      items: outputPathSchema,
      uniqueItems: true,
      maxItems: 1_000
    },
    applied: {
      const: true
    }
  }, ['patchSha256', 'files', 'applied'])
};

const actionContract = (
  input: Omit<
    LocalAgentCapabilityContract,
    'executionTarget' | 'inputSchema' | 'outputSchema'
  >
): LocalAgentCapabilityContract => ({
  ...input,
  executionTarget: 'python-daemon',
  inputSchema: LOCAL_AGENT_ACTION_INPUT_SCHEMAS[input.id],
  outputSchema: LOCAL_AGENT_ACTION_OUTPUT_SCHEMAS[input.id]
});

export const LOCAL_AGENT_CAPABILITY_CATALOG: Readonly<
  Record<LocalAgentAction, LocalAgentCapabilityContract>
> = {
  'local_agent.status': actionContract({
    id: 'local_agent.status',
    description: 'Read the paired local agent readiness and registered-workspace status.',
    risk: 'readonly',
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 10_000,
    requiredDeviceScopes: ['local_agent.status'],
    readOnly: true,
    mayModifyFiles: false
  }),
  'repo.search': actionContract({
    id: 'repo.search',
    description: 'Search bounded text or symbols within the registered workspace.',
    risk: 'readonly',
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 30_000,
    requiredDeviceScopes: ['repo.search'],
    readOnly: true,
    mayModifyFiles: false
  }),
  'git.status': actionContract({
    id: 'git.status',
    description: 'Read sanitized Git branch and worktree status for the registered workspace.',
    risk: 'readonly',
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 15_000,
    requiredDeviceScopes: ['git.status'],
    readOnly: true,
    mayModifyFiles: false
  }),
  'git.diff': actionContract({
    id: 'git.diff',
    description: 'Read a bounded sanitized Git diff between two validated refs.',
    risk: 'readonly',
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 30_000,
    requiredDeviceScopes: ['git.diff'],
    readOnly: true,
    mayModifyFiles: false
  }),
  'tests.run': actionContract({
    id: 'tests.run',
    description: 'Run one fixed, allowlisted test profile in the registered workspace.',
    risk: 'privileged',
    requiresConfirmation: true,
    idempotent: true,
    timeoutMs: 900_000,
    requiredDeviceScopes: ['tests.run'],
    readOnly: false,
    mayModifyFiles: true
  }),
  'patch.preview': actionContract({
    id: 'patch.preview',
    description: 'Validate and dry-run a bounded patch without modifying workspace files.',
    risk: 'readonly',
    requiresConfirmation: false,
    idempotent: true,
    timeoutMs: 30_000,
    requiredDeviceScopes: ['patch.preview'],
    readOnly: true,
    mayModifyFiles: false
  }),
  'patch.apply': actionContract({
    id: 'patch.apply',
    description: 'Apply one validated patch whose exact payload received GPT Access confirmation.',
    risk: 'privileged',
    requiresConfirmation: true,
    idempotent: true,
    timeoutMs: 60_000,
    requiredDeviceScopes: ['patch.apply'],
    readOnly: false,
    mayModifyFiles: true
  })
};

export const LOCAL_AGENT_ACTION_METADATA: Readonly<
  Record<LocalAgentAction, ModuleActionMetadata>
> = Object.fromEntries(
  LOCAL_AGENT_ACTIONS.map((action) => {
    const contract = LOCAL_AGENT_CAPABILITY_CATALOG[action];
    return [
      action,
      {
        description: contract.description,
        risk: contract.risk,
        requiresConfirmation: contract.requiresConfirmation,
        inputSchema: contract.inputSchema,
        outputSchema: contract.outputSchema,
        idempotent: contract.idempotent,
        executionTarget: contract.executionTarget,
        timeoutMs: contract.timeoutMs,
        requiredDeviceScopes: contract.requiredDeviceScopes,
        readOnly: contract.readOnly,
        mayModifyFiles: contract.mayModifyFiles
      }
    ];
  })
) as Record<LocalAgentAction, ModuleActionMetadata>;

export class LocalAgentContractValidationError extends Error {
  readonly action: LocalAgentAction;
  readonly direction: 'input' | 'output';
  readonly issues: Array<{
    path: string;
    keyword: string;
    message: string;
  }>;

  constructor(
    action: LocalAgentAction,
    direction: 'input' | 'output',
    errors: ErrorObject[] | null | undefined
  ) {
    super(`Invalid ${direction} for local-agent action ${action}.`);
    this.name = 'LocalAgentContractValidationError';
    this.action = action;
    this.direction = direction;
    this.issues = (errors ?? []).map((error) => ({
      path: error.instancePath || '/',
      keyword: error.keyword,
      message: error.message ?? 'Schema validation failed.'
    }));
  }
}

const ajv = new Ajv({
  allErrors: true,
  strict: true,
  validateFormats: false
});
ajv.addKeyword({
  keyword: 'maxUtf8Bytes',
  type: 'string',
  schemaType: 'number',
  errors: false,
  validate: (limit: number, value: string) =>
    Buffer.byteLength(value, 'utf8') <= limit
});

const inputValidators = Object.fromEntries(
  LOCAL_AGENT_ACTIONS.map((action) => [
    action,
    ajv.compile(LOCAL_AGENT_ACTION_INPUT_SCHEMAS[action])
  ])
) as Record<LocalAgentAction, ValidateFunction>;

const outputValidators = Object.fromEntries(
  LOCAL_AGENT_ACTIONS.map((action) => [
    action,
    ajv.compile(LOCAL_AGENT_ACTION_OUTPUT_SCHEMAS[action])
  ])
) as Record<LocalAgentAction, ValidateFunction>;

function validateContractValue<T>(
  action: LocalAgentAction,
  direction: 'input' | 'output',
  validator: ValidateFunction,
  value: unknown
): T {
  if (!validator(value)) {
    throw new LocalAgentContractValidationError(
      action,
      direction,
      validator.errors
    );
  }
  return value as T;
}

export function validateLocalAgentActionInput<TAction extends LocalAgentAction>(
  action: TAction,
  payload: unknown
): LocalAgentActionInputMap[TAction] {
  return validateContractValue<LocalAgentActionInputMap[TAction]>(
    action,
    'input',
    inputValidators[action],
    payload ?? {}
  );
}

export function validateLocalAgentActionOutput<TAction extends LocalAgentAction>(
  action: TAction,
  output: unknown
): LocalAgentActionOutputMap[TAction] {
  return validateContractValue<LocalAgentActionOutputMap[TAction]>(
    action,
    'output',
    outputValidators[action],
    output
  );
}
