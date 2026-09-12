import ArcanosKit
import Foundation

/// Explicit configuration for disposable local proofs. There are no environment,
/// UserDefaults, Keychain or developer Gateway fallbacks in this module.
public struct FixtureLoopbackConfiguration: Sendable {
    public let baseURL: URL
    public let origin: URL
    public let token: String
    public let runId: String
    public let maxRequests: Int

    public init(baseURL: URL, origin: URL, token: String, runId: String, maxRequests: Int = 4) {
        self.baseURL = baseURL; self.origin = origin; self.token = token
        self.runId = runId; self.maxRequests = maxRequests
    }

    func validate() throws {
        guard let parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port,
              (1024...65_535).contains(port), parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, parts.path.isEmpty,
              baseURL.absoluteString == "http://127.0.0.1:\(port)",
              origin.absoluteString == "https://recovery.example.invalid",
              UUID(uuidString: runId) != nil, !token.isEmpty, token.utf8.count <= 240,
              token.utf8.allSatisfy({ (33...126).contains($0) }), (1...8).contains(maxRequests) else {
            throw GatewayError.invalidConfiguration
        }
    }
}
