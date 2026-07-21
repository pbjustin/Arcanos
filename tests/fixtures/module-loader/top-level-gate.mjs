globalThis.__arcanosModuleLoaderFixtureEvents?.push('gate-start');
await globalThis.__arcanosModuleLoaderFixtureGate;
globalThis.__arcanosModuleLoaderFixtureEvents?.push('gate-finish');

export default {
  name: 'FIXTURE:GATED',
  actions: {
    async run() {
      return 'gated';
    },
  },
};
