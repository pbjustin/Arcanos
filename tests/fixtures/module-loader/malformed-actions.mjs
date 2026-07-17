globalThis.__arcanosModuleLoaderFixtureEvents?.push('malformed-actions');

export default {
  name: 'FIXTURE:MALFORMED_ACTIONS',
  actions: 'truthy-but-not-an-action-map',
};
