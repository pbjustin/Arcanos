import { z } from 'zod';
import { getEnv } from '@platform/runtime/env.js';
import { ArcanosProductivity } from '@services/arcanos-productivity.js';
import { sanitizeGptAccessString } from '@services/gptAccessSanitization.js';

const tenancyId = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const count = z.number().int().nonnegative();
const publicTitle = z.string().transform(text => sanitizeGptAccessString(text).slice(0, 240));
const recommendation = z.object({
  item: z.object({ title: publicTitle, dueAt: z.iso.datetime({ offset: true }).nullable() }),
  project: z.object({ title: publicTitle }).nullable(),
  reasonCodes: z.array(z.enum([
    'high_priority', 'overdue', 'due_today', 'due_soon', 'active_project', 'project_overdue', 'project_due_soon'
  ])).max(7)
});
const recommendations = z.array(recommendation).max(3);
const summaryView = z.object({
  generatedAt: z.iso.datetime(),
  summary: z.object({
    tasks: z.object({ open: count, inbox: count, next: count, scheduled: count, waiting: count, overdue: count, completed: count }),
    projects: z.object({ active: count, blocked: count, onHold: count, missingNextAction: count }),
    knowledge: z.object({ notes: count }),
    reviews: z.object({ dailyDue: z.boolean(), weeklyDue: z.boolean() })
  }),
  focus: recommendations
});
const focusView = z.object({ generatedAt: z.iso.datetime(), recommended: recommendations, candidateCount: count });

/** Read two fixed canonical views for the operator-configured Core owner tenancy. */
export async function inspectChatGptCoreProductivity(view: 'summary' | 'focus', actorKey: string) {
  const principalId = getEnv('CHATGPT_CORE_PRODUCTIVITY_PRINCIPAL_ID');
  const workspaceId = getEnv('CHATGPT_CORE_PRODUCTIVITY_WORKSPACE_ID');
  if (!principalId || !workspaceId || !tenancyId.test(principalId) || !tenancyId.test(workspaceId)) return null;

  const action = view === 'summary' ? 'context.summary' : 'focus.today';
  const metadata = ArcanosProductivity.actionMetadata?.[action];
  if (metadata?.risk !== 'readonly' || metadata.requiresConfirmation !== false) return null;

  const output = await ArcanosProductivity.actions[action]!({}, { source: 'gpt-access', principalId, workspaceId, actorKey });
  const schema = view === 'summary' ? summaryView : focusView;
  const result = z.object({ ok: z.literal(true), action: z.literal(action), persisted: z.literal(false), data: schema })
    .safeParse(output);
  return result.success ? { view, ...result.data.data } : null;
}
