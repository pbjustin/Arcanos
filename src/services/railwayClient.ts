import { logger } from '../utils/structuredLogging.js';

const DEFAULT_GRAPHQL_ENDPOINT = 'https://backboard.railway.app/graphql/v2';
const GRAPHQL_ENDPOINT = process.env.RAILWAY_GRAPHQL_ENDPOINT || DEFAULT_GRAPHQL_ENDPOINT;
const DEFAULT_GRAPHQL_TIMEOUT_MS = 15_000;

const GRAPHQL_TIMEOUT_MS = (() => {
  const rawTimeout = process.env.RAILWAY_GRAPHQL_TIMEOUT_MS?.trim();
  if (!rawTimeout) {
    return DEFAULT_GRAPHQL_TIMEOUT_MS;
  }

  const parsed = Number.parseInt(rawTimeout, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn('Ignoring invalid RAILWAY_GRAPHQL_TIMEOUT_MS value', {
      rawTimeout
    });
    return DEFAULT_GRAPHQL_TIMEOUT_MS;
  }

  return parsed;
})();

interface GraphQLErrorPayload {
  message: string;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorPayload[];
}

export interface RailwayProjectSummary {
  id: string;
  name: string;
  environments: Array<{
    id: string;
    name: string;
    services: Array<{
      id: string;
      name: string;
      latestDeployment?: {
        id: string;
        status: string;
        createdAt: string;
      } | null;
    }>;
  }>;
}

export interface DeployServiceOptions {
  serviceId: string;
  branch?: string;
  commitId?: string;
}

export interface RedeployEnvironmentOptions {
  environmentId: string;
}

export interface PromoteDeploymentOptions {
  deploymentId: string;
}

export interface RailwayApiProbeResult {
  ok: boolean;
  projectCount?: number;
  environmentCount?: number;
  serviceCount?: number;
}

class RailwayApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RailwayApiError';
  }
}

interface GraphQLRequestOptions {
  timeoutMs?: number;
}

function truncate(value: string, maxLength = 300): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

function getToken(): string | null {
  const token = process.env.RAILWAY_API_TOKEN?.trim();
  return token ? token : null;
}

export function isRailwayApiConfigured(): boolean {
  return Boolean(getToken());
}

async function executeGraphQL<T>(
  query: string,
  variables?: Record<string, unknown>,
  options: GraphQLRequestOptions = {}
): Promise<T> {
  const token = getToken();
  if (!token) {
    throw new RailwayApiError('Railway API token is not configured. Set RAILWAY_API_TOKEN to enable management APIs.');
  }

  const timeoutMs = options.timeoutMs ?? GRAPHQL_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  if (typeof timeoutHandle === 'object' && typeof (timeoutHandle as NodeJS.Timeout).unref === 'function') {
    (timeoutHandle as NodeJS.Timeout).unref();
  }

  let response: Response;

  try {
    response = await fetch(GRAPHQL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      throw new RailwayApiError(`Railway API request timed out after ${timeoutMs}ms`);
    }

    throw new RailwayApiError(`Railway API request failed: ${(error as Error).message}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  const raw = await response.text();
  let parsed: GraphQLResponse<T>;

  try {
    parsed = JSON.parse(raw) as GraphQLResponse<T>;
  } catch (error) {
    throw new RailwayApiError(`Failed to parse Railway API response: ${(error as Error).message}. Received: ${truncate(raw)}`);
  }

  if (!response.ok) {
    const detail = parsed.errors?.map((err) => err.message).join('; ') || truncate(raw) || response.statusText;
    throw new RailwayApiError(`Railway API request failed (${response.status}): ${detail}`);
  }

  if (parsed.errors?.length) {
    const messages = parsed.errors.map((err) => err.message).join('; ');
    throw new RailwayApiError(messages);
  }

  if (!parsed.data) {
    throw new RailwayApiError(`Railway API returned no data payload. Received: ${truncate(raw)}`);
  }

  return parsed.data;
}

export async function listProjects(): Promise<RailwayProjectSummary[]> {
  const query = `
    query ViewerProjects {
      viewer {
        projects {
          edges {
            node {
              id
              name
              environments {
                id
                name
                services {
                  id
                  name
                  latestDeployment {
                    id
                    status
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const data = await executeGraphQL<{
    viewer: {
      projects: {
        edges: Array<{
          node: RailwayProjectSummary;
        }>;
      };
    };
  }>(query);

  return data.viewer.projects.edges.map((edge) => edge.node);
}

export async function deployService(options: DeployServiceOptions): Promise<{ deploymentId: string; status: string; }> {
  const mutation = `
    mutation DeployService($input: DeployServiceInput!) {
      deployService(input: $input) {
        id
        status
      }
    }
  `;

  const variables = {
    input: {
      serviceId: options.serviceId,
      branch: options.branch,
      commitId: options.commitId
    }
  };

  const data = await executeGraphQL<{
    deployService: {
      id: string;
      status: string;
    };
  }>(mutation, variables);

  return {
    deploymentId: data.deployService.id,
    status: data.deployService.status
  };
}

export async function redeployEnvironment(options: RedeployEnvironmentOptions): Promise<{ deploymentId: string; status: string; }> {
  const mutation = `
    mutation RedeployEnvironment($input: RedeployEnvironmentInput!) {
      redeployEnvironment(input: $input) {
        id
        status
      }
    }
  `;

  const variables = {
    input: {
      environmentId: options.environmentId
    }
  };

  const data = await executeGraphQL<{
    redeployEnvironment: {
      id: string;
      status: string;
    };
  }>(mutation, variables);

  return {
    deploymentId: data.redeployEnvironment.id,
    status: data.redeployEnvironment.status
  };
}

export async function promoteDeployment(options: PromoteDeploymentOptions): Promise<{ deploymentId: string; status: string; environmentId?: string; }> {
  const mutation = `
    mutation PromoteDeployment($input: PromoteDeploymentInput!) {
      promoteDeployment(input: $input) {
        id
        status
        environmentId
      }
    }
  `;

  const variables = {
    input: {
      deploymentId: options.deploymentId
    }
  };

  const data = await executeGraphQL<{
    promoteDeployment: {
      id: string;
      status: string;
      environmentId?: string;
    };
  }>(mutation, variables);

  return {
    deploymentId: data.promoteDeployment.id,
    status: data.promoteDeployment.status,
    environmentId: data.promoteDeployment.environmentId
  };
}

export async function probeRailwayApi(): Promise<RailwayApiProbeResult> {
  if (!isRailwayApiConfigured()) {
    return { ok: false };
  }

  try {
    const projects = await listProjects();
    const projectCount = projects.length;
    const environmentCount = projects.reduce((acc, project) => acc + project.environments.length, 0);
    const serviceCount = projects.reduce((acc, project) => (
      acc + project.environments.reduce((serviceTotal, environment) => serviceTotal + environment.services.length, 0)
    ), 0);

    logger.info('Railway API probe succeeded', {
      projects: projectCount,
      environments: environmentCount,
      services: serviceCount
    });

    return {
      ok: true,
      projectCount,
      environmentCount,
      serviceCount
    };
  } catch (error) {
    logger.warn('Railway API probe failed', {
      error: (error as Error).message
    });

    return {
      ok: false
    };
  }
}

export default {
  isRailwayApiConfigured,
  listProjects,
  deployService,
  redeployEnvironment,
  promoteDeployment,
  probeRailwayApi
};
