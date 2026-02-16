import fetch from "node-fetch"

const DEFAULT_BACKEND_BASE_URL = "http://localhost:3000"

interface BackendPostOptions {
    authenticatedUserId?: string
}

function getBackendBaseUrl(): string {
    const configuredBackendUrl = process.env.ARCANOS_BACKEND_URL

    //audit Assumption: local development should default to localhost when no URL is configured.
    //audit Failure risk: hardcoded production endpoints can misroute traffic and leak data.
    //audit Expected invariant: every request resolves a concrete base URL.
    //audit Handling strategy: use env override with an explicit localhost fallback.
    if (!configuredBackendUrl) {
        return DEFAULT_BACKEND_BASE_URL
    }

    return configuredBackendUrl.replace(/\/$/, "")
}

export const backendClient = {
    /**
     * Sends a POST request to the backend gateway.
     * Inputs: path, request body, optional auth/user headers.
     * Output: parsed JSON response.
     * Edge case: throws when backend returns a non-2xx response.
     */
    async post<TRequest, TResponse = unknown>(
        path: string,
        body: TRequest,
        options: BackendPostOptions = {}
    ): Promise<TResponse> {
        const backendBaseUrl = getBackendBaseUrl()
        const headers: Record<string, string> = {
            "Content-Type": "application/json"
        }

        if (options.authenticatedUserId) {
            headers["x-arcanos-user-id"] = options.authenticatedUserId
        }

        const res = await fetch(`${backendBaseUrl}${path}`, {
            method: "POST",
            headers,
            body: JSON.stringify(body)
        })

        //audit Assumption: non-2xx responses must propagate as explicit failures to callers.
        //audit Failure risk: silently parsing error payloads hides transport/auth failures.
        //audit Expected invariant: successful requests return HTTP 2xx.
        //audit Handling strategy: throw with status details before JSON parsing.
        if (!res.ok) {
            const backendErrorPayload = await res.text()
            throw new Error(
                `Backend request failed (${res.status} ${res.statusText}): ${backendErrorPayload}`
            )
        }

        return (await res.json()) as TResponse
    }
}
