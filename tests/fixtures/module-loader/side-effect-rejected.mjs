globalThis.__arcanosModuleLoaderFixtureEvents?.push(
  `side-effect:${process.env.MODULE_LOADER_FIXTURE_FLAG ?? 'unset'}`
);

const listener = () => undefined;
const timer = setInterval(() => undefined, 60_000);

process.on('arcanos-module-loader-fixture', listener);
globalThis.__arcanosModuleLoaderFixtureListener = listener;
globalThis.__arcanosModuleLoaderFixtureTimer = timer;

export default {
  name: 'FIXTURE:SIDE_EFFECT_REJECTED',
};
