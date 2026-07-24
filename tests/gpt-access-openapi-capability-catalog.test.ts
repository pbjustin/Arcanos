import {
  buildGptAccessCapabilityCatalogExtension,
  buildGptAccessOpenApiDocument
} from '../src/services/gptAccessGateway.js';
import {
  LOCAL_AGENT_ACTIONS,
  LOCAL_AGENT_CAPABILITY_CATALOG,
  LOCAL_AGENT_MODULE_NAME
} from '../src/services/localAgent/contracts.js';
import {
  PRODUCTIVITY_ACTIONS,
  PRODUCTIVITY_MODULE_NAME
} from '../src/services/productivity/productivityTypes.js';

describe('GPT Access OpenAPI protected capability catalogs', () => {
  test('publishes the exact TypeScript productivity and local-agent catalogs', () => {
    const catalogs = buildGptAccessCapabilityCatalogExtension();

    expect(Object.keys(catalogs)).toEqual([
      PRODUCTIVITY_MODULE_NAME,
      LOCAL_AGENT_MODULE_NAME
    ]);
    expect(catalogs[PRODUCTIVITY_MODULE_NAME].actions).toEqual([
      ...PRODUCTIVITY_ACTIONS
    ]);
    expect(catalogs[LOCAL_AGENT_MODULE_NAME].actions).toEqual([
      ...LOCAL_AGENT_ACTIONS
    ]);
    expect(catalogs[LOCAL_AGENT_MODULE_NAME].contracts).toEqual(
      LOCAL_AGENT_ACTIONS.map((action) => ({
        ...LOCAL_AGENT_CAPABILITY_CATALOG[action],
        requiredDeviceScopes: [
          ...LOCAL_AGENT_CAPABILITY_CATALOG[action].requiredDeviceScopes
        ]
      }))
    );
  });

  test('attaches the deterministic catalogs to the public OpenAPI document', () => {
    const document = buildGptAccessOpenApiDocument({
      serverUrl: 'https://arcanos-preview-e2e.example.test'
    });

    expect(document['x-arcanos-capability-catalogs']).toEqual(
      buildGptAccessCapabilityCatalogExtension()
    );
  });
});
