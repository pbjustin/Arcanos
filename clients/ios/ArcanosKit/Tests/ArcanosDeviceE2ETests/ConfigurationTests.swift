import ArcanosKit
import Foundation
import Testing
@testable import ArcanosDeviceE2E

private func fixtureConfiguration(_ replacements: [String: String] = [:]) throws -> Data {
    var values = ["version": "ios-device-e2e/v1", "runId": "11111111-1111-4111-8111-111111111111",
                  "sourceSha": String(repeating: "a", count: 40), "baseURL": "http://127.0.0.1:41000",
                  "origin": "https://device-e2e.example.invalid",
                  "pairingTokenA": "agp1." + String(repeating: "A", count: 43),
                  "pairingTokenB": "agp1." + String(repeating: "B", count: 43),
                  "expectedAIAnswer": "Synthetic device E2E answer."]
    for (key, value) in replacements { values[key] = value }
    return try JSONEncoder().encode(values)
}

@Suite("Device cross-process fixture network boundaries")
struct DeviceProofConfigurationTests {
    @Test(arguments: [[], ["--execute"], ["--allow-loopback"], ["--execute", "--allow-network"],
                      ["--execute", "--allow-loopback", "--allow-loopback"]])
    func explicitOptInRequired(arguments: [String]) throws {
        #expect(throws: (any Error).self) {
            try DeviceProofConfiguration.read(fixtureConfiguration(), arguments: arguments)
        }
    }

    @Test(arguments: ["http://localhost:41000", "http://127.0.0.2:41000", "https://127.0.0.1:41000",
                      "http://127.0.0.1", "http://127.0.0.1:80", "http://127.0.0.1:41000/",
                      "http://user@127.0.0.1:41000", "http://127.0.0.1:41000?x=1"])
    func nonexactLoopbackDestinationDenied(baseURL: String) throws {
        #expect(throws: (any Error).self) {
            try DeviceProofConfiguration.read(fixtureConfiguration(["baseURL": baseURL]),
                                              arguments: ["--execute", "--allow-loopback"])
        }
    }

    @Test func fixtureIdentityAndBootstrapAreValidated() throws {
        for invalid in [["version": "other"], ["runId": "not-a-run"], ["sourceSha": "main"],
                        ["origin": "https://production.example.com"], ["pairingTokenA": "operator-secret"],
                        ["pairingTokenB": "agp1." + String(repeating: "A", count: 43)]] {
            #expect(throws: (any Error).self) {
                try DeviceProofConfiguration.read(fixtureConfiguration(invalid), arguments: ["--execute", "--allow-loopback"])
            }
        }
    }

    @Test func validFixtureMapsOnlyReviewedClientRoutes() throws {
        let config = try DeviceProofConfiguration.read(fixtureConfiguration(), arguments: ["--execute", "--allow-loopback"])
        let request = GatewayRequest(url: config.origin.appendingPathComponent("gpt-access/devices/pair"),
                                     method: "POST", headers: [:], body: Data("{}".utf8))
        #expect(try LoopbackTransport.destination(request, configuration: config).absoluteString
                == "http://127.0.0.1:41000/gpt-access/devices/pair")
        let wrongMethod = GatewayRequest(url: request.url, method: "GET", headers: [:])
        #expect(throws: (any Error).self) { try LoopbackTransport.destination(wrongMethod, configuration: config) }
        let oversized = GatewayRequest(url: request.url, method: "POST", headers: [:], body: Data(repeating: 0, count: 65_537))
        #expect(throws: (any Error).self) { try LoopbackTransport.destination(oversized, configuration: config) }
    }

    @Test(arguments: ["https://other.example.invalid/gpt-access/devices/pair",
                      "https://device-e2e.example.invalid/gpt-access/devices/pairing",
                      "https://device-e2e.example.invalid/gpt-access/devices/pair?x=1",
                      "https://device-e2e.example.invalid/admin", "http://device-e2e.example.invalid/gpt-access/devices/pair"])
    func otherOriginsAndRoutesNeverReachTransport(address: String) throws {
        let config = try DeviceProofConfiguration.read(fixtureConfiguration(), arguments: ["--execute", "--allow-loopback"])
        let request = GatewayRequest(url: URL(string: address)!, method: "POST", headers: [:])
        #expect(throws: (any Error).self) { try LoopbackTransport.destination(request, configuration: config) }
    }
}
