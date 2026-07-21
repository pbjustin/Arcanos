globalThis.__arcanosModuleLoaderFixtureEvents?.push('accepted');

export default {
  name: 'FIXTURE:ACCEPTED',
  actions: {
    async run() {
      return 'accepted';
    },
  },
};
