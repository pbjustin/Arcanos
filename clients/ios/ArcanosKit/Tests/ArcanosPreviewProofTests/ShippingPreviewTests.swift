import ArcanosKit
import Foundation
import Testing
@testable import ArcanosPreviewProof

struct ShippingPreviewTests {
    private let origin = URL(string: "https://web-pr-1499.up.railway.app")!
    private var arguments: [String] {
        ["--shipping-recovery-phase", "dismiss-submit", "--store-path", "/tmp/outside/index.json", "--device-id", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
         "--repository-root", "/tmp/arcanos-proof", "--pr-number", "1499", "--commit-sha", String(repeating: "a", count: 40),
         "--web-base-url", origin.absoluteString, "--worker-base-url", "https://worker-pr-1499.up.railway.app"]
    }
    @Test func defaultAdmissionIsOfflineAndStoreStaysOutsideCheckout() throws {
        #expect(try ShippingPreviewConfiguration(arguments: arguments).preview.execute == false)
        #expect(try ShippingPreviewConfiguration(arguments: arguments + ["--execute", "--allow-network"]).preview.execute == true)
        for path in ["/tmp/arcanos-proof", "/tmp/arcanos-proof/index.json", "relative/index.json", "/tmp/line\nfile"] {
            var input = arguments; input[3] = path
            #expect(throws: ProofFailure.self) { try ShippingPreviewConfiguration(arguments: input) }
        }
    }
    @Test func symlinkCannotPutRecoveryIndexInsideAttestedCheckout() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let repository = directory.appendingPathComponent("repository"), alias = directory.appendingPathComponent("alias")
        try FileManager.default.createDirectory(at: repository, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: repository)
        var input = arguments; input[3] = alias.appendingPathComponent("index.json").path; input[7] = repository.path
        #expect(throws: ProofFailure.self) { try ShippingPreviewConfiguration(arguments: input) }
    }
    @Test(arguments: [["--execute"], ["--allow-network"], ["--token", "operator"], ["--execute", "--execute", "--allow-network"]])
    func partialOptInAndCredentialArgumentsAreDenied(extra: [String]) {
        #expect(throws: ProofFailure.self) { try ShippingPreviewConfiguration(arguments: arguments + extra) }
    }
    private func request() -> GatewayRequest {
        GatewayRequest(url: URL(string: PreviewFixture.runPath, relativeTo: origin)!.absoluteURL,
            method: "POST", headers: ["Authorization": "Bearer " + ShippingPreviewTransport.deviceToken,
                "X-Arcanos-Device-Origin": origin.absoluteString, "Accept": "application/json", "Cache-Control": "no-store",
                "Content-Type": "application/json", "Idempotency-Key": "fixed-key"], body: Data("{\"action\":\"tests.run\"}".utf8))
    }
    @Test func credentialAdapterPreservesBodyURLAndIdempotency() throws {
        let original = request(), mapped = try ShippingPreviewTransport.fixtureRequest(original, origin: origin)
        #expect(mapped.url == original.url && mapped.method == original.method && mapped.body == original.body)
        var expected = original.headers; expected["Authorization"] = "Bearer " + PreviewFixture.token
        #expect(mapped.headers == expected)
    }
    @Test func credentialAdapterRejectsAnyOtherCredentialAndCarrier() throws {
        let original = request()
        for (key, value) in [("Authorization", "Bearer operator"), ("Authorization", "Bearer " + PreviewFixture.token),
                             ("Authorization", "Bearer agd1." + String(repeating: "B", count: 43)),
                             ("authorization", "Bearer private"), ("X-Arcanos-Device-Origin", "https://other.example.invalid"),
                             ("Cookie", "private"), ("x-native-preview-fixture", "arbitrary"), ("Content-Type", "text/plain")] {
            var headers = original.headers; headers[key] = value
            #expect(throws: ProofFailure.self) {
                try ShippingPreviewTransport.fixtureRequest(GatewayRequest(url: original.url, method: original.method,
                    headers: headers, body: original.body), origin: origin)
            }
        }
    }
    @Test(arguments: ["http://web-pr-1499.up.railway.app/gpt-access/jobs/create",
        "https://other-pr-1499.up.railway.app/gpt-access/jobs/create", "https://web-pr-1499.up.railway.app/gpt/arcanos-core",
        "https://web-pr-1499.up.railway.app/gpt-access/jobs/create?token=private", "https://user@web-pr-1499.up.railway.app/gpt-access/jobs/create",
        "https://web-pr-1499.up.railway.app:443/gpt-access/jobs/create"])
    func adapterDeniesUnapprovedRoutesBeforeAnyNetwork(url: String) async throws {
        let actual = ObservedTransport(web: origin, worker: URL(string: "https://worker-pr-1499.up.railway.app")!)
        await actual.admit()
        let adapter = ShippingPreviewTransport(actual: actual, origin: origin), original = request()
        await #expect(throws: ProofFailure.self) {
            try await adapter.send(GatewayRequest(url: URL(string: url)!, method: original.method, headers: original.headers, body: original.body))
        }
        #expect(await actual.count() == 0)
    }
}
