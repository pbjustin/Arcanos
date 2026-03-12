import {
  buildFineTuneDataset,
  serializeExamplesToJsonl,
  serializeIndexToJsonl,
  type ChatExportConversation,
  type ChatExportMessage,
  type ChatExportNode
} from '../src/training/openaiFineTuneDataset';

function buildNode(
  id: string,
  parent: string | null,
  message: ChatExportMessage | null
): ChatExportNode {
  return {
    id,
    parent,
    children: [],
    message
  };
}

describe('openaiFineTuneDataset', () => {
  test('builds turn-level examples from visible text and multimodal replies', () => {
    const conversation: ChatExportConversation = {
      id: 'conversation-1',
      title: 'Example training conversation',
      current_node: 'assistant-2',
      default_model_slug: 'gpt-4.1',
      mapping: {
        root: {
          id: 'root',
          parent: null,
          children: ['user-1'],
          message: null
        },
        'user-1': {
          id: 'user-1',
          parent: 'root',
          children: ['assistant-1'],
          message: {
            id: 'user-1',
            author: { role: 'user' },
            recipient: 'all',
            status: 'finished_successfully',
            content: {
              content_type: 'text',
              parts: ['Email me at dev@example.com']
            }
          }
        },
        'assistant-1': {
          id: 'assistant-1',
          parent: 'user-1',
          children: ['user-2'],
          message: {
            id: 'assistant-1',
            author: { role: 'assistant' },
            recipient: 'all',
            status: 'finished_successfully',
            content: {
              content_type: 'text',
              parts: [
                '### Answer\nUse [redacted placeholder] and keep the reply short.\n\n### Audit Summary\ninternal only'
              ]
            }
          }
        },
        'user-2': {
          id: 'user-2',
          parent: 'assistant-1',
          children: ['assistant-2'],
          message: {
            id: 'user-2',
            author: { role: 'user' },
            recipient: 'all',
            status: 'finished_successfully',
            content: {
              content_type: 'multimodal_text',
              parts: [
                {
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'file-service://image-1'
                },
                'What does this screenshot show?'
              ]
            }
          }
        },
        'assistant-2': {
          id: 'assistant-2',
          parent: 'user-2',
          children: [],
          message: {
            id: 'assistant-2',
            author: { role: 'assistant' },
            recipient: 'all',
            status: 'finished_successfully',
            content: {
              content_type: 'multimodal_text',
              parts: [
                {
                  content_type: 'audio_transcription',
                  text: 'It shows the deployment health dashboard. citeturn0search1\n\n✅ **ARCANOS Final Note:** Keep it focused.'
                },
                {
                  content_type: 'audio_asset_pointer',
                  asset_pointer: 'sediment://audio-1'
                }
              ]
            }
          }
        }
      }
    };

    const result = buildFineTuneDataset([conversation], { validationRatio: 0 });

    expect(result.summary.examplesBuilt).toBe(2);
    expect(result.trainExamples).toHaveLength(2);
    expect(result.validationExamples).toHaveLength(0);
    expect(result.trainExamples[0].messages).toEqual([
      { role: 'user', content: 'Email me at [redacted-email]' },
      { role: 'assistant', content: 'Use [redacted placeholder] and keep the reply short.' }
    ]);
    expect(result.trainExamples[1].messages).toEqual([
      { role: 'user', content: 'Email me at [redacted-email]' },
      { role: 'assistant', content: 'Use [redacted placeholder] and keep the reply short.' },
      { role: 'user', content: 'What does this screenshot show?' },
      { role: 'assistant', content: 'It shows the deployment health dashboard.\n\nKeep it focused.' }
    ]);
    expect(serializeExamplesToJsonl(result.trainExamples).split('\n')).toHaveLength(2);
    expect(serializeIndexToJsonl(result.trainExamples).split('\n')).toHaveLength(2);
  });

  test('skips conversations when a visible human turn has no extractable text', () => {
    const conversation: ChatExportConversation = {
      id: 'conversation-2',
      title: 'Asset only prompt',
      current_node: 'assistant-1',
      mapping: {
        root: {
          id: 'root',
          parent: null,
          children: ['user-1'],
          message: null
        },
        'user-1': {
          id: 'user-1',
          parent: 'root',
          children: ['assistant-1'],
          message: {
            id: 'user-1',
            author: { role: 'user' },
            recipient: 'all',
            status: 'finished_successfully',
            content: {
              content_type: 'multimodal_text',
              parts: [
                {
                  content_type: 'image_asset_pointer',
                  asset_pointer: 'file-service://image-only'
                },
                ''
              ]
            }
          }
        },
        'assistant-1': buildNode('assistant-1', 'user-1', {
          id: 'assistant-1',
          author: { role: 'assistant' },
          recipient: 'all',
          status: 'finished_successfully',
          content: {
            content_type: 'text',
            parts: ['This answer should be skipped because the prompt was image-only.']
          }
        })
      }
    };

    const result = buildFineTuneDataset([conversation], { validationRatio: 0 });

    expect(result.summary.examplesBuilt).toBe(0);
    expect(result.summary.skippedConversationReasons.textless_human_turns).toBe(1);
  });

  test('falls back to the latest leaf when current_node is missing', () => {
    const conversation: ChatExportConversation = {
      id: 'conversation-3',
      title: 'Fallback branch tip',
      current_node: null,
      mapping: {
        root: {
          id: 'root',
          parent: null,
          children: ['user-1'],
          message: null
        },
        'user-1': {
          id: 'user-1',
          parent: 'root',
          children: ['assistant-1'],
          message: {
            id: 'user-1',
            author: { role: 'user' },
            recipient: 'all',
            status: 'finished_successfully',
            content: {
              content_type: 'text',
              parts: ['Summarize the deployment.']
            }
          }
        },
        'assistant-1': {
          id: 'assistant-1',
          parent: 'user-1',
          children: [],
          message: {
            id: 'assistant-1',
            author: { role: 'assistant' },
            recipient: 'all',
            status: 'finished_successfully',
            update_time: 200,
            content: {
              content_type: 'text',
              parts: ['The deployment is healthy.']
            }
          }
        },
        'assistant-older': {
          id: 'assistant-older',
          parent: 'user-1',
          children: [],
          message: {
            id: 'assistant-older',
            author: { role: 'assistant' },
            recipient: 'all',
            status: 'finished_successfully',
            update_time: 100,
            content: {
              content_type: 'text',
              parts: ['Older branch reply.']
            }
          }
        }
      }
    };

    const result = buildFineTuneDataset([conversation], { validationRatio: 0 });

    expect(result.summary.examplesBuilt).toBe(1);
    expect(result.trainExamples[0].targetMessageId).toBe('assistant-1');
    expect(result.trainExamples[0].messages.at(-1)?.content).toBe('The deployment is healthy.');
  });

  test('rejects invalid validation ratios', () => {
    expect(() => buildFineTuneDataset([], { validationRatio: 0.75 })).toThrow(
      'validationRatio must be between 0 and 0.5'
    );
  });
});
