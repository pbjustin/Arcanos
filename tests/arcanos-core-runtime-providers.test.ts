import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const routeOperatorCommandThroughDispatchMock = jest.fn();

jest.unstable_mockModule(
  '@services/gptAccessNaturalLanguageDispatch.js',
  () => ({
    routeOperatorCommandThroughDispatch: routeOperatorCommandThroughDispatchMock,
  })
);

const {
  configureArcanosCoreOperatorDispatch,
  getArcanosCoreOperatorDispatch,
} = await import('../src/services/arcanosCoreOperatorDispatchPort.js');
const { configureDefaultArcanosCoreRuntimeProviders } =
  await import('../src/services/arcanosCoreRuntimeProviders.js');

describe('ARCANOS core runtime providers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configureArcanosCoreOperatorDispatch(null);
  });

  it('binds the GPT Access operator dispatcher at composition time', async () => {
    routeOperatorCommandThroughDispatchMock.mockResolvedValue(null);
    configureDefaultArcanosCoreRuntimeProviders();

    await expect(getArcanosCoreOperatorDispatch()({
      utterance: 'Check backend health.',
      context: {
        sourceEndpoint: 'test',
      },
    })).resolves.toBeNull();
    expect(routeOperatorCommandThroughDispatchMock).toHaveBeenCalledWith({
      utterance: 'Check backend health.',
      context: {
        sourceEndpoint: 'test',
      },
    });
  });
});
