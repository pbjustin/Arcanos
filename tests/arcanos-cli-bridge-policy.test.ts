import { describe, expect, it } from '@jest/globals';

import {
  isArcanosCliReadOnlyAction,
  proposeArcanosCliCommand
} from '../src/services/arcanosCliBridge.js';

describe('ARCANOS CLI bridge action policy', () => {
  it('exposes a predicate without publishing mutable policy state', async () => {
    expect(isArcanosCliReadOnlyAction('status')).toBe(true);
    expect(isArcanosCliReadOnlyAction(' proposePatch ')).toBe(true);
    expect(isArcanosCliReadOnlyAction('runApprovedCommand')).toBe(false);
    expect(isArcanosCliReadOnlyAction('applyApprovedPatch')).toBe(false);

    const bridgeExports = await import('../src/services/arcanosCliBridge.js');
    expect('CLI_READONLY_ACTIONS' in bridgeExports).toBe(false);
  });

  it('redacts Backstage Notion credentials with the tracked bridge policy', () => {
    const proposal = proposeArcanosCliCommand({
      command: 'git status ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN=notion-secret-value '
        + 'ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON={ "private-universe": ['
        + ' { "page": "private-universe-page-id", "note": "escaped \\\" } ]" }'
        + ' ] }adjacent-private-page-tail SAFE_FLAG=true suffix'
    });

    expect(proposal.commandPreview).toContain('ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN=[REDACTED]');
    expect(proposal.commandPreview).toContain('ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON=[REDACTED]');
    expect(proposal.commandPreview).toContain('SAFE_FLAG=true suffix');
    expect(proposal.commandPreview).not.toContain('notion-secret-value');
    expect(proposal.commandPreview).not.toContain('private-universe-page-id');
    expect(proposal.commandPreview).not.toContain('adjacent-private-page-tail');
  });
});
