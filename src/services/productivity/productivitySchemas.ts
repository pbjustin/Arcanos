import { z } from 'zod';

import {
  PRODUCTIVITY_PROJECT_STATUSES,
  PRODUCTIVITY_REVIEW_KINDS,
  PRODUCTIVITY_TASK_STATUSES
} from './productivityTypes.js';

const titleSchema = z.string().trim().min(1).max(240);
const detailsSchema = z.string().trim().min(1).max(20_000);
const contentSchema = z.string().trim().min(1).max(100_000);
const referenceSchema = z.string().trim().min(1).max(240);
const idempotencyKeySchema = z.string().trim().min(1).max(240);
const versionSchema = z.number().int().positive();
const prioritySchema = z.number().int().min(0).max(4);
const limitSchema = z.number().int().min(1).max(100).default(50);
const timestampSchema = z.string().datetime({ offset: true });
const dateSchema = z.string().date();
const taskStatusSchema = z.enum(PRODUCTIVITY_TASK_STATUSES);
const projectStatusSchema = z.enum(PRODUCTIVITY_PROJECT_STATUSES);
const reviewKindSchema = z.enum(PRODUCTIVITY_REVIEW_KINDS);

export const emptyProductivityInputSchema = z.object({}).strict();

export const intentResolveInputSchema = z.object({
  utterance: z.string().trim().min(1).max(1_000)
}).strict();

export const referenceResolveInputSchema = z.object({
  entityType: z.enum(['task', 'project']),
  reference: referenceSchema
}).strict();

export const inboxListInputSchema = z.object({
  limit: limitSchema.optional()
}).strict();

export const taskListInputSchema = z.object({
  status: taskStatusSchema.optional(),
  projectId: z.string().uuid().optional(),
  limit: limitSchema.optional()
}).strict();

export const projectListInputSchema = z.object({
  status: projectStatusSchema.optional(),
  limit: limitSchema.optional()
}).strict();

export const projectHealthInputSchema = z.object({
  project: referenceSchema.optional()
}).strict();

export const knowledgeFindInputSchema = z.object({
  query: z.string().trim().min(1).max(500).optional(),
  projectId: z.string().uuid().optional(),
  limit: limitSchema.optional()
}).strict();

export const captureAddInputSchema = z.object({
  text: titleSchema,
  notes: detailsSchema.optional(),
  projectId: z.string().uuid().optional(),
  priority: prioritySchema.default(0),
  dueAt: timestampSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const inboxProcessInputSchema = z.object({
  task: referenceSchema,
  status: z.enum(['next', 'scheduled', 'waiting', 'cancelled']),
  projectId: z.string().uuid().optional(),
  priority: prioritySchema.optional(),
  notes: detailsSchema.optional(),
  dueAt: timestampSchema.nullable().optional(),
  deferUntil: timestampSchema.nullable().optional(),
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const taskCreateInputSchema = z.object({
  title: titleSchema,
  details: detailsSchema.optional(),
  status: z.enum(['inbox', 'next', 'scheduled', 'waiting']).default('next'),
  projectId: z.string().uuid().optional(),
  priority: prioritySchema.default(0),
  dueAt: timestampSchema.optional(),
  deferUntil: timestampSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const taskCompleteInputSchema = z.object({
  task: referenceSchema,
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const taskDeferInputSchema = z.object({
  task: referenceSchema,
  until: timestampSchema,
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const taskTransitionInputSchema = z.object({
  task: referenceSchema,
  status: taskStatusSchema,
  projectId: z.string().uuid().optional(),
  priority: prioritySchema.optional(),
  details: detailsSchema.optional(),
  dueAt: timestampSchema.nullable().optional(),
  deferUntil: timestampSchema.nullable().optional(),
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const projectCreateInputSchema = z.object({
  title: titleSchema,
  description: detailsSchema.optional(),
  dueAt: timestampSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const projectAdvanceInputSchema = z.object({
  project: referenceSchema,
  nextAction: titleSchema,
  details: detailsSchema.optional(),
  priority: prioritySchema.default(0),
  dueAt: timestampSchema.optional(),
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const projectTransitionInputSchema = z.object({
  project: referenceSchema,
  status: projectStatusSchema,
  expectedVersion: versionSchema.optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const knowledgeStoreInputSchema = z.object({
  title: titleSchema.optional(),
  content: contentSchema,
  projectId: z.string().uuid().optional(),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const reviewRecordInputSchema = z.object({
  kind: reviewKindSchema,
  reviewDate: dateSchema.optional(),
  summary: detailsSchema,
  completed: z.array(titleSchema).max(100).default([]),
  concerns: z.array(titleSchema).max(100).default([]),
  nextActions: z.array(titleSchema).max(100).default([]),
  idempotencyKey: idempotencyKeySchema.optional()
}).strict();

export const reviewReadInputSchema = z.object({
  date: dateSchema.optional()
}).strict();

const objectSchema = (
  properties: Record<string, unknown> = {},
  required: string[] = []
): Record<string, unknown> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false
});

const stringField = (description: string, format?: string): Record<string, unknown> => ({
  type: 'string',
  description,
  ...(format ? { format } : {})
});

const trimmedStringSchema = (maxLength: number): Record<string, unknown> => ({
  type: 'string',
  minLength: 1,
  maxLength,
  pattern: '\\S'
});

const trimmedStringField = (
  description: string,
  maxLength: number
): Record<string, unknown> => ({
  ...trimmedStringSchema(maxLength),
  description
});

const titleField = (description: string): Record<string, unknown> =>
  trimmedStringField(description, 240);
const detailsField = (description: string): Record<string, unknown> =>
  trimmedStringField(description, 20_000);
const contentField = (description: string): Record<string, unknown> =>
  trimmedStringField(description, 100_000);
const referenceField = (description: string): Record<string, unknown> =>
  trimmedStringField(description, 240);
const idempotencyField = trimmedStringField(
  'Optional caller idempotency key. Reuse it only for an identical semantic command.',
  240
);

export const PRODUCTIVITY_ACTION_INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  'intent.catalog': objectSchema(),
  'intent.resolve': objectSchema({
    utterance: trimmedStringField('Natural-language productivity request to classify.', 1_000)
  }, ['utterance']),
  'state.current': objectSchema(),
  'context.summary': objectSchema(),
  'reference.resolve': objectSchema({
    entityType: { type: 'string', enum: ['task', 'project'] },
    reference: referenceField('Entity UUID or human-readable title reference.')
  }, ['entityType', 'reference']),
  'inbox.list': objectSchema({
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  'task.list': objectSchema({
    status: { type: 'string', enum: PRODUCTIVITY_TASK_STATUSES },
    projectId: stringField('Optional project UUID.', 'uuid'),
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  'project.list': objectSchema({
    status: { type: 'string', enum: PRODUCTIVITY_PROJECT_STATUSES },
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  'project.health': objectSchema({
    project: referenceField('Optional project UUID or title reference.')
  }),
  'focus.today': objectSchema(),
  'knowledge.find': objectSchema({
    query: trimmedStringField('Optional case-insensitive text query.', 500),
    projectId: stringField('Optional project UUID.', 'uuid'),
    limit: { type: 'integer', minimum: 1, maximum: 100 }
  }),
  'review.daily': objectSchema({
    date: stringField('Optional review date.', 'date')
  }),
  'review.weekly': objectSchema({
    date: stringField('Optional review date.', 'date')
  }),
  'capture.add': objectSchema({
    text: titleField('Inbox item text.'),
    notes: detailsField('Optional supporting details.'),
    projectId: stringField('Optional project UUID.', 'uuid'),
    priority: { type: 'integer', minimum: 0, maximum: 4, default: 0 },
    dueAt: stringField('Optional ISO-8601 due timestamp.', 'date-time'),
    idempotencyKey: idempotencyField
  }, ['text']),
  'inbox.process': objectSchema({
    task: referenceField('Inbox task UUID or title reference.'),
    status: { type: 'string', enum: ['next', 'scheduled', 'waiting', 'cancelled'] },
    projectId: stringField('Optional project UUID.', 'uuid'),
    priority: { type: 'integer', minimum: 0, maximum: 4 },
    notes: detailsField('Optional replacement details.'),
    dueAt: { type: ['string', 'null'], format: 'date-time' },
    deferUntil: { type: ['string', 'null'], format: 'date-time' },
    expectedVersion: { type: 'integer', minimum: 1 },
    idempotencyKey: idempotencyField
  }, ['task', 'status']),
  'task.create': objectSchema({
    title: titleField('Concrete next-action title.'),
    details: detailsField('Optional task details.'),
    status: { type: 'string', enum: ['inbox', 'next', 'scheduled', 'waiting'], default: 'next' },
    projectId: stringField('Optional project UUID.', 'uuid'),
    priority: { type: 'integer', minimum: 0, maximum: 4, default: 0 },
    dueAt: stringField('Optional ISO-8601 due timestamp.', 'date-time'),
    deferUntil: stringField('Optional ISO-8601 defer timestamp.', 'date-time'),
    idempotencyKey: idempotencyField
  }, ['title']),
  'task.complete': objectSchema({
    task: referenceField('Task UUID or title reference.'),
    expectedVersion: { type: 'integer', minimum: 1 },
    idempotencyKey: idempotencyField
  }, ['task']),
  'task.defer': objectSchema({
    task: referenceField('Task UUID or title reference.'),
    until: stringField('ISO-8601 timestamp when the task becomes available.', 'date-time'),
    expectedVersion: { type: 'integer', minimum: 1 },
    idempotencyKey: idempotencyField
  }, ['task', 'until']),
  'task.transition': objectSchema({
    task: referenceField('Task UUID or title reference.'),
    status: { type: 'string', enum: PRODUCTIVITY_TASK_STATUSES },
    projectId: stringField('Optional project UUID.', 'uuid'),
    priority: { type: 'integer', minimum: 0, maximum: 4 },
    details: detailsField('Optional replacement details.'),
    dueAt: { type: ['string', 'null'], format: 'date-time' },
    deferUntil: { type: ['string', 'null'], format: 'date-time' },
    expectedVersion: { type: 'integer', minimum: 1 },
    idempotencyKey: idempotencyField
  }, ['task', 'status']),
  'project.create': objectSchema({
    title: titleField('Finite project outcome title.'),
    description: detailsField('Optional project outcome description.'),
    dueAt: stringField('Optional ISO-8601 due timestamp.', 'date-time'),
    idempotencyKey: idempotencyField
  }, ['title']),
  'project.advance': objectSchema({
    project: referenceField('Project UUID or title reference.'),
    nextAction: titleField('Concrete next action to create for the project.'),
    details: detailsField('Optional next-action details.'),
    priority: { type: 'integer', minimum: 0, maximum: 4, default: 0 },
    dueAt: stringField('Optional next-action due timestamp.', 'date-time'),
    expectedVersion: { type: 'integer', minimum: 1 },
    idempotencyKey: idempotencyField
  }, ['project', 'nextAction']),
  'project.transition': objectSchema({
    project: referenceField('Project UUID or title reference.'),
    status: { type: 'string', enum: PRODUCTIVITY_PROJECT_STATUSES },
    expectedVersion: { type: 'integer', minimum: 1 },
    idempotencyKey: idempotencyField
  }, ['project', 'status']),
  'knowledge.store': objectSchema({
    title: titleField('Optional note title.'),
    content: contentField('Durable note content.'),
    projectId: stringField('Optional project UUID.', 'uuid'),
    idempotencyKey: idempotencyField
  }, ['content']),
  'review.record': objectSchema({
    kind: { type: 'string', enum: PRODUCTIVITY_REVIEW_KINDS },
    reviewDate: stringField('Review date.', 'date'),
    summary: detailsField('Review summary.'),
    completed: { type: 'array', items: trimmedStringSchema(240), maxItems: 100, default: [] },
    concerns: { type: 'array', items: trimmedStringSchema(240), maxItems: 100, default: [] },
    nextActions: { type: 'array', items: trimmedStringSchema(240), maxItems: 100, default: [] },
    idempotencyKey: idempotencyField
  }, ['kind', 'summary'])
};
