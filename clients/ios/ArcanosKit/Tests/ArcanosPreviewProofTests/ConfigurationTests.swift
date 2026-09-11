import ArcanosKit
import Foundation
import Testing
@testable import ArcanosPreviewProof

struct ConfigurationTests {
    private let base = ["--pr-number", "1495", "--commit-sha", String(repeating: "a", count: 40),
                        "--repository-root", "/tmp/arcanos-proof", "--web-base-url", "https://arcanos-pr-1495-web.up.railway.app",
                        "--worker-base-url", "https://arcanos-pr-1495-worker.up.railway.app"]

    @Test func defaultIsOffline() throws {
        #expect(try ProofConfiguration(arguments: base).execute == false)
        #expect(try ProofConfiguration(arguments: base + ["--execute", "--allow-network"]).execute == true)
    }

    @Test(arguments: [["--execute"], ["--allow-network"], ["--execute", "--execute", "--allow-network"], ["--token", "secret"], ["--pr-number", "1496"]])
    func incompleteOrUnexpectedArgumentsAreRejected(extra: [String]) {
        #expect(throws: ProofFailure.self) { try ProofConfiguration(arguments: base + extra) }
    }

    @Test(arguments: ["https://arcanos-production.up.railway.app", "https://arcanos-pr-1496-web.up.railway.app", "https://arcanos-pr-1495-web.example.com",
                      "http://arcanos-pr-1495-web.up.railway.app", "https://user@arcanos-pr-1495-web.up.railway.app", "https://arcanos-pr-1495-web.up.railway.app/path",
                      "https://arcanos-pr-1495-web.up.railway.app?token=secret", "https://arcanos-pr-1495-web.up.railway.app:443", "https://arcanos-pr-1495-worker.up.railway.app"])
    func nonPreviewOrAmbiguousOriginsAreRejected(origin: String) {
        var arguments = base
        arguments[7] = origin
        #expect(throws: ProofFailure.self) { try ProofConfiguration(arguments: arguments) }
    }

    @Test func canonicalRequestsCannotTransmitBeforeReadinessAdmission() async throws {
        let configuration = try ProofConfiguration(arguments: base)
        let transport = ObservedTransport(web: configuration.web, worker: configuration.worker)
        await #expect(throws: ProofFailure.self) {
            try await transport.send(GatewayRequest(url: URL(string: PreviewFixture.createPath, relativeTo: configuration.web)!.absoluteURL,
                                                    method: "POST", headers: [:], body: Data("{}".utf8)))
        }
        #expect(await transport.count() == 0)
    }

    @Test func transportRejectsNonFixtureRoutesEvenAfterAdmission() async throws {
        let configuration = try ProofConfiguration(arguments: base)
        let transport = ObservedTransport(web: configuration.web, worker: configuration.worker)
        await transport.admit()
        await #expect(throws: ProofFailure.self) {
            try await transport.send(GatewayRequest(url: URL(string: "/gpt/arcanos-core", relativeTo: configuration.web)!.absoluteURL,
                                                    method: "POST", headers: [:], body: Data("{}".utf8)))
        }
        #expect(await transport.count() == 0)
    }

    @Test func devicePolicyRequestsRefuseCarriersBodiesAndWrongMethod() async throws {
        let configuration = try ProofConfiguration(arguments: base)
        let transport = ObservedTransport(web: configuration.web, worker: configuration.worker)
        let url = URL(string: PreviewFixture.devicePolicyPath, relativeTo: configuration.web)!.absoluteURL
        for header in ["Authorization", "authorization", "x-native-preview-fixture", "Idempotency-Key"] {
            await #expect(throws: ProofFailure.self) {
                try await transport.send(GatewayRequest(url: url, method: "GET", headers: [header: "fixture-marker"]))
            }
        }
        await #expect(throws: ProofFailure.self) {
            try await transport.send(GatewayRequest(url: url, method: "GET", headers: [:], body: Data("{}".utf8)))
        }
        await #expect(throws: ProofFailure.self) {
            try await transport.send(GatewayRequest(url: url, method: "POST", headers: [:]))
        }
        #expect(await transport.count() == 0)
    }
}
