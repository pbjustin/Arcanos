import ArcanosKit
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

private final class RecoveryRedirectDenial: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Explicit fixture adapter: the production GatewayClient constructs the wire request,
/// while URLSession sends only to the parent-owned HTTP loopback server. No TLS proof.
actor RecoveryLoopbackTransport: GatewayTransport {
    private let configuration: RecoveryConfiguration
    private let session: URLSession
    private let delegate = RecoveryRedirectDenial()
    private let deadline = Date().addingTimeInterval(30)
    private var requests = 0
    private var transportFailures = 0
    private var responseBytes = 0

    init(configuration: RecoveryConfiguration) throws {
        try configuration.validate()
        self.configuration = configuration
        let settings = URLSessionConfiguration.ephemeral
        settings.urlCache = nil
        settings.httpCookieStorage = nil
        settings.urlCredentialStorage = nil
        settings.httpShouldSetCookies = false
        settings.connectionProxyDictionary = [:]
        settings.requestCachePolicy = .reloadIgnoringLocalCacheData
        settings.timeoutIntervalForRequest = 5
        settings.timeoutIntervalForResource = 6
        session = URLSession(configuration: settings, delegate: delegate, delegateQueue: nil)
    }

    func count() -> Int { requests }
    func transportFailureCount() -> Int { transportFailures }

    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        try Task.checkCancellation()
        guard let parts = URLComponents(url: request.url, resolvingAgainstBaseURL: false),
              parts.scheme == "https", parts.host == "recovery.example.invalid", parts.port == nil,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              request.method == "POST", ["/gpt-access/jobs/create", "/gpt-access/jobs/result"].contains(parts.path),
              parts.percentEncodedPath == parts.path, let body = request.body, body.count <= 16_384,
              request.headers["Authorization"] == "Bearer \(configuration.token)",
              request.headers["X-Arcanos-Device-Origin"] == configuration.origin.absoluteString,
              request.headers.keys.allSatisfy({ !["cookie", "proxy-authorization", "x-arcanos-fixture-run-id"].contains($0.lowercased()) }),
              let destination = URL(string: parts.path, relativeTo: configuration.baseURL)?.absoluteURL,
              destination.host == "127.0.0.1", destination.port == configuration.baseURL.port else {
            throw RecoveryFailure("RECOVERY_REQUEST_DENIED")
        }
        try recoveryRequire(requests < 4 && Date() < deadline, "RECOVERY_NETWORK_BUDGET_EXHAUSTED")
        requests += 1
        var outgoing = URLRequest(url: destination)
        outgoing.httpMethod = request.method
        outgoing.httpBody = body
        outgoing.allHTTPHeaderFields = request.headers
        outgoing.setValue(configuration.runId, forHTTPHeaderField: "x-arcanos-fixture-run-id")
        let data: Data
        let response: URLResponse
        do { (data, response) = try await session.data(for: outgoing) }
        catch let error as URLError {
            transportFailures += 1
            throw error
        }
        responseBytes += data.count
        guard let http = response as? HTTPURLResponse, http.url == destination,
              data.count <= 65_536, responseBytes <= 131_072, Date() < deadline else {
            throw RecoveryFailure("RECOVERY_RESPONSE_INVALID")
        }
        guard !(300...399).contains(http.statusCode) else { throw GatewayError.redirectRejected }
        return GatewayResponse(statusCode: http.statusCode, data: data)
    }
}
