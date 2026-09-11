import ArcanosKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class RejectFixtureRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// This is an explicit test adapter, not the shipping HTTPS transport. Real URLSession
/// exchanges exact client wire bodies/headers with one disposable HTTP loopback server.
/// No TLS verification setting, machine trust store, or production implementation changes.
actor LoopbackTransport: GatewayTransport {
    private let configuration: DeviceProofConfiguration
    private let session: URLSession
    private let delegate = RejectFixtureRedirects()
    private let deadline = Date().addingTimeInterval(60)
    private var requestCount = 0
    private var responseBytes = 0
    private var createdAIJobID: String?
    private var capabilityRequests: [GatewayRequest] = []
    private var createRequests = 0
    private var resultRequests = 0

    init(configuration: DeviceProofConfiguration) throws {
        try configuration.validate()
        self.configuration = configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        settings.urlCredentialStorage = nil
        settings.httpShouldSetCookies = false
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 5
        settings.timeoutIntervalForResource = 6
        session = URLSession(configuration: settings, delegate: delegate, delegateQueue: nil)
    }

    func counts() -> (requests: Int, bytes: Int) { (requestCount, responseBytes) }
    func observedAIJobID() -> String? { createdAIJobID }
    func shippingCounts() -> (creates: Int, capabilities: Int, results: Int) {
        (createRequests, capabilityRequests.count, resultRequests)
    }

    func confirmedRetryIsExact() -> Bool {
        guard capabilityRequests.count == 3 else { return false }
        let original = capabilityRequests[1], approved = capabilityRequests[2]
        guard original.url == approved.url, original.method == approved.method,
              original.headers == approved.headers, let before = original.body, let after = approved.body,
              after.starts(with: before.dropLast()),
              let originalBody = try? JSONDecoder().decode([String: JSONValue].self, from: before),
              var approvedBody = try? JSONDecoder().decode([String: JSONValue].self, from: after),
              case .string(let token)? = approvedBody.removeValue(forKey: "confirmation_token"), !token.isEmpty else { return false }
        return approvedBody == originalBody
    }

    nonisolated static func destination(_ request: GatewayRequest, configuration: DeviceProofConfiguration) throws -> URL {
        guard let parts = URLComponents(url: request.url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "device-e2e.example.invalid", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              request.body == nil || request.body!.count <= 65_536 else {
            throw DeviceProofFailure("REQUEST_ORIGIN_OR_BODY_DENIED")
        }
        let reads = ["/gpt-access/devices/session", "/gpt-access/capabilities/v1"]
        let writes = ["/gpt-access/devices/pair", "/gpt-access/devices/renew", "/gpt-access/jobs/create",
                      "/gpt-access/jobs/result", "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run"]
        let revoke = parts.path.range(of: "^/gpt-access/devices/[a-fA-F0-9-]{36}/revoke$", options: .regularExpression) != nil
        try deviceRequire((request.method == "GET" && reads.contains(parts.path))
                          || (request.method == "POST" && (writes.contains(parts.path) || revoke)), "REQUEST_ROUTE_DENIED")
        guard let destination = URL(string: parts.percentEncodedPath, relativeTo: configuration.baseURL)?.absoluteURL,
              destination.host == "127.0.0.1", destination.port == configuration.baseURL.port else {
            throw DeviceProofFailure("REQUEST_LOOPBACK_INVALID")
        }
        return destination
    }

    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        try Task.checkCancellation()
        let destination = try Self.destination(request, configuration: configuration)
        try deviceRequire(requestCount < 80 && Date() < deadline, "NETWORK_BUDGET_EXHAUSTED")
        requestCount += 1
        if request.url.path == "/gpt-access/jobs/create" { createRequests += 1 }
        if request.url.path == "/gpt-access/jobs/result" { resultRequests += 1 }
        if request.url.path == "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run" {
            capabilityRequests.append(request)
        }
        var outgoing = URLRequest(url: destination)
        outgoing.httpMethod = request.method
        outgoing.httpBody = request.body
        outgoing.allHTTPHeaderFields = request.headers
        let (data, reply) = try await session.data(for: outgoing)
        guard let response = reply as? HTTPURLResponse, response.url == destination else {
            throw DeviceProofFailure("HTTP_RESPONSE_INVALID")
        }
        responseBytes += data.count
        try deviceRequire(data.count <= 2_097_152 && responseBytes <= 4_194_304 && Date() < deadline,
                          "RESPONSE_BUDGET_EXHAUSTED")
        guard !(300...399).contains(response.statusCode) else { throw GatewayError.redirectRejected }
        if request.url.path == "/gpt-access/jobs/create", response.statusCode == 202,
           let receipt = try? JSONDecoder().decode(CreateAIJobResponse.self, from: data), receipt.ok,
           UUID(uuidString: receipt.jobId) != nil {
            createdAIJobID = receipt.jobId
        }
        return GatewayResponse(statusCode: response.statusCode, data: data)
    }
}
