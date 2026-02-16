import http, { IncomingMessage, ServerResponse } from "node:http"

const DEFAULT_PORT = 3000
const LISTEN_HOST = "0.0.0.0"
const HEALTH_PATH = "/health"

interface RuntimeConfiguration {
    port: number
}

/**
 * Resolves runtime server configuration from environment variables.
 * Input: process environment map.
 * Output: normalized runtime configuration object.
 * Edge case: falls back to DEFAULT_PORT when PORT is missing or invalid.
 */
export function resolveRuntimeConfiguration(
    environmentVariables: NodeJS.ProcessEnv = process.env
): RuntimeConfiguration {
    const parsedPort = Number(environmentVariables.PORT ?? DEFAULT_PORT)

    //audit Assumption: PORT is either undefined or a positive integer string.
    //audit Failure risk: invalid PORT values can crash startup or bind to an unexpected port.
    //audit Expected invariant: server binds to a positive integer port.
    //audit Handling strategy: validate and fallback to DEFAULT_PORT.
    if (!Number.isInteger(parsedPort) || parsedPort <= 0) {
        return { port: DEFAULT_PORT }
    }

    return { port: parsedPort }
}

/**
 * Writes a JSON HTTP response with a stable content type.
 * Input: node response object, status code, and serializable payload.
 * Output: sends a completed HTTP response.
 * Edge case: serializes empty object payloads as "{}".
 */
export function sendJsonResponse(
    response: ServerResponse,
    statusCode: number,
    payload: Record<string, unknown>
): void {
    response.writeHead(statusCode, { "Content-Type": "application/json" })
    response.end(JSON.stringify(payload))
}

/**
 * Handles incoming HTTP requests for the backend scaffold.
 * Input: node request and response objects.
 * Output: sends a health or service metadata response.
 * Edge case: returns 404 JSON for unsupported routes.
 */
export function handleHttpRequest(
    request: IncomingMessage,
    response: ServerResponse
): void {
    const requestPath = request.url ?? "/"

    //audit Assumption: health checks target "/health" for container readiness probes.
    //audit Failure risk: missing health endpoint can cause false negative deploy health checks.
    //audit Expected invariant: "/health" responds with HTTP 200.
    //audit Handling strategy: return deterministic health payload.
    if (requestPath === HEALTH_PATH) {
        sendJsonResponse(response, 200, {
            status: "ok",
            service: "arcanos-backend"
        })
        return
    }

    //audit Assumption: scaffold should expose an explicit not-found payload for unknown routes.
    //audit Failure risk: silent 200 responses can mask route misconfiguration.
    //audit Expected invariant: unsupported routes return HTTP 404.
    //audit Handling strategy: return structured error payload with route context.
    sendJsonResponse(response, 404, {
        error: "not_found",
        path: requestPath
    })
}

/**
 * Starts the backend HTTP server.
 * Input: optional environment variable map.
 * Output: running node HTTP server instance.
 * Edge case: startup errors are surfaced via the server "error" event.
 */
export function startBackendServer(
    environmentVariables: NodeJS.ProcessEnv = process.env
): http.Server {
    const runtimeConfiguration = resolveRuntimeConfiguration(environmentVariables)
    const server = http.createServer(handleHttpRequest)

    server.listen(runtimeConfiguration.port, LISTEN_HOST, () => {
        console.log(
            `Arcanos backend listening on http://${LISTEN_HOST}:${runtimeConfiguration.port}`
        )
    })

    server.on("error", (error: Error) => {
        //audit Assumption: startup/runtime errors should terminate process to avoid partial service behavior.
        //audit Failure risk: swallowing server errors can leave deployment unhealthy without signaling failure.
        //audit Expected invariant: fatal server errors are surfaced to orchestration.
        //audit Handling strategy: log once and exit with non-zero status.
        console.error("Fatal backend server error:", error)
        process.exit(1)
    })

    return server
}

startBackendServer()
