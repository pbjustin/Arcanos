import ArcanosKit
import ArcanosFixtureSupport

/// Preserves the original core-proof API with the shared fixture-only transport.
actor RecoveryLoopbackTransport: GatewayTransport {
    private let transport: FixtureLoopbackTransport
    init(configuration: RecoveryConfiguration) throws {
        try configuration.validate()
        transport = try FixtureLoopbackTransport(configuration: FixtureLoopbackConfiguration(
            baseURL: configuration.baseURL, origin: configuration.origin,
            token: configuration.token, runId: configuration.runId, maxRequests: 4))
    }
    func count() async -> Int { await transport.count() }
    func transportFailureCount() async -> Int { await transport.transportFailureCount() }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse { try await transport.send(request) }
}
