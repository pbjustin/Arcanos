import { request as requestHttps } from 'node:https';

const NOTION_CANARY_HOST = 'api.notion.com';
const NOTION_CANARY_PATH = '/v1/users/me';
const NOTION_CANARY_TIMEOUT_MS = 4_000;
const NOTION_CANARY_VERSION = '2022-06-28';

export interface BackstageNotionPreviewConnectivityResult {
  apiReached: true;
  authenticationRejected: true;
}

/**
 * Prove fixed-destination Railway egress to the Notion API without carrying a
 * real credential or reading provider content. The synthetic credential must
 * be rejected; any other response fails the sealed preview contract.
 */
export async function probeBackstageNotionPreviewConnectivity():
Promise<BackstageNotionPreviewConnectivityResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error('PREVIEW_BACKSTAGE_NOTION_CONNECTIVITY_UNAVAILABLE'));
    };
    const request = requestHttps({
      headers: {
        Accept: 'application/json',
        Authorization: ['Bearer', 'arcanos-preview-invalid-non-secret'].join(' '),
        'Notion-Version': NOTION_CANARY_VERSION,
        'User-Agent': 'Arcanos-PR-Preview-Notion-Canary/1.0',
      },
      hostname: NOTION_CANARY_HOST,
      method: 'GET',
      path: NOTION_CANARY_PATH,
      port: 443,
      protocol: 'https:',
      signal: AbortSignal.timeout(NOTION_CANARY_TIMEOUT_MS),
    }, response => {
      const contentType = typeof response.headers['content-type'] === 'string'
        ? response.headers['content-type'].toLowerCase()
        : '';
      const valid = response.statusCode === 401
        && contentType.startsWith('application/json');
      response.destroy();
      if (!valid) {
        fail();
        return;
      }
      settled = true;
      resolve({
        apiReached: true,
        authenticationRejected: true,
      });
    });

    request.once('error', fail);
    request.end();
  });
}
