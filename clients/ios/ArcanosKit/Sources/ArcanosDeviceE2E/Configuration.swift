import Foundation

struct DeviceProofFailure: Error, Sendable {
    let code: String
    init(_ code: String) { self.code = code }
}

func deviceRequire(_ condition: Bool, _ code: String) throws {
    guard condition else { throw DeviceProofFailure(code) }
}

/// Stdin carries only disposable fixture material. No external origin, operator
/// credential, TLS override, or arbitrary request can be supplied to this runner.
struct DeviceProofConfiguration: Decodable, Sendable {
    let version: String
    let runId: String
    let sourceSha: String
    let baseURL: URL
    let origin: URL
    let pairingTokenA: String
    let pairingTokenB: String
    let expectedAIAnswer: String

    static func read(_ data: Data, arguments: [String]) throws -> Self {
        try deviceRequire(arguments == ["--execute", "--allow-loopback"], "EXPLICIT_LOOPBACK_OPT_IN_REQUIRED")
        try deviceRequire(data.count <= 16_384, "CONFIGURATION_TOO_LARGE")
        guard let configuration = try? JSONDecoder().decode(Self.self, from: data) else {
            throw DeviceProofFailure("CONFIGURATION_INVALID")
        }
        try configuration.validate()
        return configuration
    }

    func validate() throws {
        try deviceRequire(version == "ios-device-e2e/v1", "FIXTURE_VERSION_INVALID")
        try deviceRequire(UUID(uuidString: runId) != nil, "RUN_ID_INVALID")
        try deviceRequire(sourceSha.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
                          "SOURCE_SHA_INVALID")
        guard let parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
              parts.scheme == "http", parts.host == "127.0.0.1", let port = parts.port,
              (1024...65_535).contains(port), parts.path.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              baseURL.absoluteString == "http://127.0.0.1:\(port)" else {
            throw DeviceProofFailure("LOOPBACK_ORIGIN_INVALID")
        }
        try deviceRequire(origin.absoluteString == "https://device-e2e.example.invalid", "LOGICAL_ORIGIN_INVALID")
        for token in [pairingTokenA, pairingTokenB] {
            try deviceRequire(token.range(of: "^agp1\\.[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                              "PAIRING_FIXTURE_INVALID")
        }
        try deviceRequire(pairingTokenA != pairingTokenB, "PAIRING_FIXTURES_MUST_DIFFER")
        try deviceRequire(!expectedAIAnswer.isEmpty && expectedAIAnswer.utf8.count <= 1024,
                          "ANSWER_FIXTURE_INVALID")
    }
}
