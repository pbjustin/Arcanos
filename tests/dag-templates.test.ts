import { describe, expect, it } from '@jest/globals';

import {
  buildDagTemplate,
  resolvePublicDagTemplateName,
  TRINITY_CORE_DAG_TEMPLATE_NAME,
  UnsupportedDagTemplateError
} from '../src/dag/templates.js';

describe('DAG template normalization', () => {
  it('collapses supported legacy aliases to the canonical Trinity template name', () => {
    expect(resolvePublicDagTemplateName('default')).toBe(TRINITY_CORE_DAG_TEMPLATE_NAME);
    expect(resolvePublicDagTemplateName('verification-default')).toBe(TRINITY_CORE_DAG_TEMPLATE_NAME);
    expect(resolvePublicDagTemplateName('archetype-v2')).toBe(TRINITY_CORE_DAG_TEMPLATE_NAME);
  });

  it('builds the Trinity graph for legacy aliases while exposing the canonical template name', () => {
    const template = buildDagTemplate({
      sessionId: 'template-session',
      template: 'archetype-v2',
      input: {
        goal: 'Verify Trinity template normalization.'
      }
    });

    expect(template.templateName).toBe(TRINITY_CORE_DAG_TEMPLATE_NAME);
    expect(template.graph.id).toBe(TRINITY_CORE_DAG_TEMPLATE_NAME);
    expect(template.graph.entrypoints).toEqual(['planner']);
    expect(template.nodeMetadataById.writer.agentRole).toBe('writer');
    expect(template.graph.nodes.planner.metadata).toEqual(expect.objectContaining({
      pipeline: 'trinity',
      pipelineTemplate: TRINITY_CORE_DAG_TEMPLATE_NAME,
      agentRole: 'planner',
      jobType: 'plan'
    }));
  });

  it('rejects unknown template names after normalization', () => {
    expect(() =>
      buildDagTemplate({
        sessionId: 'template-session',
        template: 'unknown-template',
        input: {
          goal: 'Reject unsupported templates.'
        }
      })
    ).toThrow(UnsupportedDagTemplateError);
  });
});
