import ArcanosKit
import Foundation
import Testing
@testable import ArcanosDeviceE2E

@Suite("Shipping device proof admission")
struct ShippingConfigurationTests {
    private func withConfiguration(_ body: ([String: Any]) throws -> Void) throws {
        let runID = UUID().uuidString.lowercased()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("arcanos-ios-shipping-" + runID)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: directory) }
        let session = DeviceCredentialResponse(ok: true, deviceId: UUID().uuidString.lowercased(),
            credential: "agd1." + String(repeating: "C", count: 43), tokenType: "Bearer", audience: "gpt-access-device-v1",
            origin: "https://device-e2e.example.invalid", issuedAt: "2026-01-01T00:00:00Z", expiresAt: "2026-01-01T01:00:00Z",
            renewalExpiresAt: "2026-01-02T00:00:00Z", scopes: ["jobs.create", "jobs.result"], capabilityActions: [], gptIds: ["arcanos-core"])
        try body([
            "phase": "ai-submit", "stateDirectory": directory.absoluteString,
            "session": JSONSerialization.jsonObject(with: JSONEncoder().encode(session)),
            "fixture": ["version": "ios-device-e2e/v1", "runId": runID, "sourceSha": String(repeating: "a", count: 40),
                "baseURL": "http://127.0.0.1:41000", "origin": "https://device-e2e.example.invalid",
                "pairingTokenA": "agp1." + String(repeating: "A", count: 43), "pairingTokenB": "agp1." + String(repeating: "B", count: 43),
                "expectedAIAnswer": "Synthetic device E2E answer."],
        ])
    }

    @Test func exactOwnedDirectoryAndPhaseAccepted() throws {
        try withConfiguration { config in
            let value = try ShippingDeviceConfiguration.read(JSONSerialization.data(withJSONObject: config),
                arguments: ["--execute", "--allow-loopback", "--shipping-recovery"])
            #expect(value.phase == "ai-submit")
            #expect(value.stateDirectory.isFileURL)
        }
    }

    @Test func unrelatedDirectoriesAndUnknownPhasesRejected() throws {
        try withConfiguration { original in
            for replacement in [["stateDirectory": "https://device-e2e.example.invalid"],
                ["stateDirectory": FileManager.default.temporaryDirectory.absoluteString], ["phase": "execute-arbitrary-action"]] {
                var config = original
                for (key, value) in replacement { config[key] = value }
                #expect(throws: (any Error).self) {
                    try ShippingDeviceConfiguration.read(JSONSerialization.data(withJSONObject: config),
                        arguments: ["--execute", "--allow-loopback", "--shipping-recovery"])
                }
            }
        }
    }

    @Test func explicitShippingModeRequired() throws {
        try withConfiguration { config in
            for arguments in [[], ["--execute", "--allow-loopback"], ["--execute", "--shipping-recovery"]] {
                #expect(throws: (any Error).self) {
                    try ShippingDeviceConfiguration.read(JSONSerialization.data(withJSONObject: config), arguments: arguments)
                }
            }
        }
    }
}
