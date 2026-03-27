import { getRailwayApiConfig, RAILWAY_DEFAULTS } from "@platform/runtime/railway.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { getEnv } from "@platform/runtime/env.js";

const railwayApiConfig = getRailwayApiConfig();

const graphqlTimeoutEnv = getEnv('RAILWAY_GRAPHQL_TIMEOUT_MS');
if (
  graphqlTimeoutEnv &&
  railwayApiConfig.timeoutMs === RAILWAY_DEFAULTS.GRAPHQL_TIMEOUT_MS &&
  graphqlTimeoutEnv.trim() !== `${RAILWAY_DEFAULTS.GRAPHQL_TIMEOUT_MS}`
) {
  logger.warn('Ignoring invalid RAILWAY_GRAPHQL_TIMEOUT_MS value', {
    rawTimeout: graphqlTimeoutEnv,
  });
}

const { endpoint: GRAPHQL_ENDPOINT, timeoutMs: GRAPHQL_TIMEOUT_MS } = railwayApiConfig;

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
  environmentId: string;
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

interface RailwayProjectEdge {
  node: RailwayProjectSummary;
}

const PROJECT_SUMMARY_SELECTION = `
  id
  name
  environments {
    edges {
      node {
        id
        name
        serviceInstances {
          edges {
            node {
              id
              serviceId
              serviceName
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
`;

interface RailwayServiceInstanceNode {
  id: string;
  serviceId?: string | null;
  serviceName: string;
  latestDeployment?: RailwayProjectSummary['environments'][number]['services'][number]['latestDeployment'];
}

interface RailwayServiceInstanceEdge {
  node: RailwayServiceInstanceNode;
}

interface RailwayEnvironmentNode {
  id: string;
  name: string;
  serviceInstances: {
    edges: RailwayServiceInstanceEdge[];
  };
}

interface RailwayEnvironmentEdge {
  node: RailwayEnvironmentNode;
}

interface RailwayProjectConnectionNode {
  id: string;
  name: string;
  environments: {
    edges: RailwayEnvironmentEdge[];
  };
}

interface RailwayProjectConnectionEdge {
  node: RailwayProjectConnectionNode;
}

interface ViewerProjectsResponse {
  viewer: {
    projects: {
      edges: RailwayProjectConnectionEdge[];
    };
  };
}

interface RootProjectsResponse {
  projects: {
    edges: RailwayProjectConnectionEdge[];
  };
}

function truncate(value: string, maxLength = 300): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}…`;
}

function getToken(): string | null {
  // Use config layer for env access (adapter boundary pattern)
  const token = getEnv('RAILWAY_API_TOKEN')?.trim();
  return token ? token : null;
}

/**
 * Purpose: report whether the Railway management API is available to this process.
 * Inputs/outputs: accepts no inputs and returns true when `RAILWAY_API_TOKEN` is present.
 * Edge cases: whitespace-only token values are treated as missing.
 */
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

function buildProjectsQuery(scope: 'root' | 'viewer'): string {
  if (scope === 'viewer') {
    return `
      query ViewerProjects {
        viewer {
          projects {
            edges {
              node {
                ${PROJECT_SUMMARY_SELECTION}
              }
            }
          }
        }
      }
    `;
  }

  return `
    query Projects {
      projects {
        edges {
          node {
            ${PROJECT_SUMMARY_SELECTION}
          }
        }
      }
    }
  `;
}

function shouldRetryProjectsQueryWithViewerScope(errorMessage: string): boolean {
  return errorMessage.includes('Cannot query field "projects" on type "Query"');
}

function mapProjectConnectionNodeToSummary(projectNode: RailwayProjectConnectionNode): RailwayProjectSummary {
  return {
    id: projectNode.id,
    name: projectNode.name,
    environments: projectNode.environments.edges.map((environmentEdge) => ({
      id: environmentEdge.node.id,
      name: environmentEdge.node.name,
      //audit Assumption: Railway service instances resolve to a stable service id or fall back to the instance id; failure risk: downstream deploy flows lose the service identifier when only one field is present; expected invariant: each summarized service retains a non-empty identifier and human-readable name; handling strategy: prefer `serviceId`, then fall back to the instance id exposed by the connection node.
      services: environmentEdge.node.serviceInstances.edges.map((serviceEdge) => ({
        id: serviceEdge.node.serviceId ?? serviceEdge.node.id,
        name: serviceEdge.node.serviceName,
        latestDeployment: serviceEdge.node.latestDeployment ?? null
      }))
    }))
  };
}

/**
 * Purpose: list Railway projects visible to the configured management token.
 * Inputs/outputs: accepts no inputs and returns project summaries with environments and services.
 * Edge cases: retries with the legacy `viewer.projects` schema only when the root `projects` field is unavailable.
 */
export async function listProjects(): Promise<RailwayProjectSummary[]> {
  const rootQuery = buildProjectsQuery('root');

  try {
    const rootData = await executeGraphQL<RootProjectsResponse>(rootQuery);
    //audit Assumption: the root-scoped projects query returns fully populated project summaries; failure risk: probe metrics undercount Railway topology; expected invariant: environments and services remain intact for each returned project; handling strategy: pass through the node payload without lossy reshaping.
    return rootData.projects.edges.map((edge) => mapProjectConnectionNodeToSummary(edge.node));
  } catch (error) {
    const errorMessage = (error as Error).message;
    const shouldRetryWithViewerScope = shouldRetryProjectsQueryWithViewerScope(errorMessage);

    //audit Assumption: only the specific root-projects schema mismatch should fall back; failure risk: masking auth, permission, or network faults with an unrelated retry; expected invariant: unexpected Railway failures remain visible to operators; handling strategy: rethrow unchanged errors unless the missing-field mismatch is explicit.
    if (!shouldRetryWithViewerScope) {
      throw error;
    }

    //audit Assumption: older Railway GraphQL schemas can still expose projects through `viewer.projects`; failure risk: backwards compatibility break for older tokens or environments; expected invariant: the compatibility probe only runs after an explicit root-schema mismatch; handling strategy: retry once with the legacy viewer-scoped query.
    logger.info('Railway GraphQL root projects query unsupported; retrying project probe with viewer query', {
      error: errorMessage
    });
  }

  const viewerData = await executeGraphQL<ViewerProjectsResponse>(buildProjectsQuery('viewer'));
  //audit Assumption: the legacy viewer-scoped query returns the same project summary contract as the root query; failure risk: compatibility mode drops environments or services; expected invariant: callers receive a consistent `RailwayProjectSummary[]` shape regardless of schema version; handling strategy: return the viewer node payload directly.
  return viewerData.viewer.projects.edges.map((edge) => mapProjectConnectionNodeToSummary(edge.node));
}

/**
 * Purpose: trigger a Railway redeploy for a specific service instance in an environment.
 * Inputs/outputs: accepts service and environment identifiers and returns whether Railway accepted the redeploy request.
 * Edge cases: throws a structured Railway API error when the token is missing, the request times out, or the API rejects the mutation.
 */
export async function deployService(options: DeployServiceOptions): Promise<{
  accepted: boolean;
  status: string;
}> {
  const mutation = `
    mutation ServiceInstanceRedeploy($environmentId: String!, $serviceId: String!) {
      serviceInstanceRedeploy(environmentId: $environmentId, serviceId: $serviceId)
    }
  `;

  const variables = {
    environmentId: options.environmentId,
    serviceId: options.serviceId
  };

  const data = await executeGraphQL<{
    serviceInstanceRedeploy: boolean;
  }>(mutation, variables);

  return {
    accepted: data.serviceInstanceRedeploy,
    status: data.serviceInstanceRedeploy ? 'TRIGGERED' : 'REJECTED'
  };
}

/**
 * Purpose: redeploy the latest build target for a Railway environment.
 * Inputs/outputs: accepts an environment id and returns the replacement deployment id and status.
 * Edge cases: propagates structured Railway API failures instead of returning partial deployment state.
 */
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

/**
 * Purpose: promote an existing Railway deployment into its target environment.
 * Inputs/outputs: accepts a deployment id and returns the promoted deployment id, status, and optional environment id.
 * Edge cases: preserves Railway API errors so callers can distinguish failed promotions from missing data.
 */
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

/**
 * Purpose: validate Railway management API connectivity during startup.
 * Inputs/outputs: accepts no inputs and returns a non-throwing probe result with project, environment, and service counts when available.
 * Edge cases: returns `{ ok: false }` instead of throwing when the token is absent or the probe request fails.
 */
export async function probeRailwayApi(): Promise<RailwayApiProbeResult> {
  if (!isRailwayApiConfigured()) {
    return { ok: false };
  }

  try {
    const projects = await listProjects();
    //audit Assumption: project summaries always expose array shapes for environments and services; failure risk: malformed probe payloads produce misleading counts; expected invariant: counts are derived only from normalized arrays returned by `listProjects`; handling strategy: aggregate counts from the typed project summary contract.
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
    //audit Assumption: startup connectivity probe failures should degrade gracefully; failure risk: startup aborts even though management features are optional; expected invariant: runtime can continue without Railway management access; handling strategy: log the failure and return `{ ok: false }`.
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
