export interface NativePrPreviewE2eContract {
  readonly schemaVersion: 1;
  readonly mode: 'native-pr-application-e2e-v1';
  readonly trustScope: 'trusted-pr-accidental-effects';
  readonly invalidJobId: 'not-a-uuid';
  readonly unlistedJobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab';
  readonly research: Readonly<{
    path: '/research/contract';
    fixtures: Readonly<{
      topicExact: 'topic-exact';
      topicOver: 'topic-over';
      urlCountExact: 'url-count-exact';
      urlCountOver: 'url-count-over';
      urlItemExact: 'url-item-exact';
      urlItemOver: 'url-item-over';
      urlAggregateExact: 'url-aggregate-exact';
      urlAggregateOver: 'url-aggregate-over';
      urlSnapshot: 'url-snapshot';
      storageComponent: 'storage-component';
    }>;
  }>;
  readonly fixtures: Readonly<{
    completed: '11111111-1111-4111-8111-111111111111';
    failed: '22222222-2222-4222-8222-222222222222';
    cancellable: '33333333-3333-4333-8333-333333333333';
    terminal: '44444444-4444-4444-8444-444444444444';
    repositoryUnavailable: '55555555-5555-4555-8555-555555555555';
    missing: '66666666-6666-4666-8666-666666666666';
    authUnavailable: '77777777-7777-4777-8777-777777777777';
    unauthorized: '88888888-8888-4888-8888-888888888888';
    cancellationUnavailable: '99999999-9999-4999-8999-999999999999';
  }>;
}

export const NATIVE_PR_PREVIEW_E2E_CONTRACT:
  NativePrPreviewE2eContract;
