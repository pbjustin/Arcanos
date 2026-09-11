import ArcanosKit
import Foundation
import Testing
@testable import ArcanosPreviewProof

struct ResponseEvidenceTests {
    private let jobID = "14950000-0000-4000-8000-000000000001"

    private func devicePolicyBody() -> [String: JSONValue] {
        ["ok": .bool(true), "synthetic": .bool(true), "proofVersion": .string("ios-device-policy/v1"),
         "prNumber": .integer(1496), "sourceCommit": .string(String(repeating: "a", count: 40)),
         "checks": .object([
             "grantAndOriginValidation": .bool(true), "credentialExpiryAndRenewal": .bool(true),
             "revocationAndAudience": .bool(true), "ownerIsolation": .bool(true),
             "missingOwnerDenied": .bool(true), "requesterIdempotencyIsolation": .bool(true),
             "operatorIdempotencyCompatibility": .bool(true)
         ]),
         "boundaries": .object([
             "grantSchema": .bool(true), "credentialStatePolicy": .bool(true),
             "deviceJobOwnership": .bool(true), "requesterIdempotency": .bool(true)
         ]), "protectedEffectsEnabled": .bool(false)]
    }

    private func checkDevicePolicy(_ body: [String: JSONValue], status: Int = 200) throws {
        try ResponseEvidence.devicePolicy(GatewayResponse(statusCode: status, data: JSONEncoder().encode(body)),
                                          prNumber: 1496, sourceCommit: String(repeating: "a", count: 40))
    }

    @Test func devicePolicyRequiresExactIdentityVersionAndFlags() throws {
        try checkDevicePolicy(devicePolicyBody())
        #expect(throws: ProofFailure.self) { try checkDevicePolicy(devicePolicyBody(), status: 503) }
        let mutations: [String: JSONValue] = [
            "ok": .bool(false), "synthetic": .bool(false), "protectedEffectsEnabled": .bool(true),
            "prNumber": .integer(1495), "sourceCommit": .string(String(repeating: "b", count: 40)),
            "proofVersion": .string("ios-device-policy/v2"), "unexpected": .bool(true)
        ]
        for (key, value) in mutations {
            var body = devicePolicyBody()
            body[key] = value
            #expect(throws: ProofFailure.self) { try checkDevicePolicy(body) }
        }
    }

    @Test func devicePolicyRequiresEveryGuardAndBoundary() throws {
        for group in ["checks", "boundaries"] {
            guard case .object(let values) = devicePolicyBody()[group] else { Issue.record("Fixture group missing"); return }
            for key in values.keys {
                var body = devicePolicyBody()
                var failed = values
                failed[key] = .bool(false)
                body[group] = .object(failed)
                #expect(throws: ProofFailure.self) { try checkDevicePolicy(body) }
                failed.removeValue(forKey: key)
                body[group] = .object(failed)
                #expect(throws: ProofFailure.self) { try checkDevicePolicy(body) }
            }
        }
    }

    private func exchange(path: String, status: Int, response: JSONValue) throws -> ObservedTransport.Exchange {
        let request = GatewayRequest(url: URL(string: "https://arcanos-pr-1495-web.up.railway.app\(path)")!, method: "POST", headers: [:],
                                     body: try JSONEncoder().encode(JSONValue.object(["jobId": .string(jobID)])))
        return ObservedTransport.Exchange(request: request, response: GatewayResponse(statusCode: status, data: try JSONEncoder().encode(response)))
    }

    private func result(_ status: String, jobID: String? = nil) -> JSONValue {
        .object(["ok": .bool(true), "jobId": .string(jobID ?? self.jobID), "status": .string(status), "result": .null,
                 "lifecycleStatus": .string(status), "poll": .string(PreviewFixture.resultPath),
                 "stream": .string(PreviewFixture.resultPath), "resultEndpoint": .string(PreviewFixture.resultPath),
                 "error": status == "failed" ? .object(["code": .string("IOS_PREVIEW_JOB_FAILED"), "message": .string("Synthetic job failure.")]) : .null])
    }

    @Test func failedScenarioRequiresMatchingReceivedFailureSequence() throws {
        let receipt = try exchange(path: PreviewFixture.createPath, status: 202, response: result("queued"))
        let pending = try exchange(path: PreviewFixture.resultPath, status: 200, response: result("pending"))
        let failed = try exchange(path: PreviewFixture.resultPath, status: 200, response: result("failed"))
        try ResponseEvidence.aiSequence([receipt, pending, failed], terminalStatus: "failed")
        #expect(throws: ProofFailure.self) { try ResponseEvidence.aiSequence([], terminalStatus: "failed") }
        #expect(throws: ProofFailure.self) { try ResponseEvidence.aiSequence([receipt, pending], terminalStatus: "failed") }
        let wrongJob = try exchange(path: PreviewFixture.resultPath, status: 200, response: result("failed", jobID: "14950000-0000-4000-8000-000000000002"))
        #expect(throws: ProofFailure.self) { try ResponseEvidence.aiSequence([receipt, pending, wrongJob], terminalStatus: "failed") }
        let malformed = try exchange(path: PreviewFixture.resultPath, status: 200, response: .object([
            "ok": .bool(true), "jobId": .string(jobID), "status": .string("failed"), "result": .null,
            "error": .object(["code": .string("IOS_PREVIEW_JOB_FAILED")])]))
        #expect(throws: ProofFailure.self) { try ResponseEvidence.aiSequence([receipt, pending, malformed], terminalStatus: "failed") }
    }

    @Test func unavailableScenarioRequires503AndPrivateMarker() throws {
        let error: JSONValue = .object(["ok": .bool(false), "error": .object([
            "code": .string("IOS_PREVIEW_UNAVAILABLE"), "message": .string("SYNTHETIC_IOS_PREVIEW_PRIVATE_ERROR_MARKER")])])
        try ResponseEvidence.unavailable([exchange(path: PreviewFixture.createPath, status: 503, response: error)])
        #expect(throws: ProofFailure.self) { try ResponseEvidence.unavailable([]) }
        #expect(throws: ProofFailure.self) { try ResponseEvidence.unavailable([exchange(path: PreviewFixture.createPath, status: 401, response: error)]) }
    }

    @Test func overlappingScenarioRequiresTwoEqualApplicableResponses() throws {
        let complete: JSONValue = .object(["ok": .bool(true), "jobId": .string(jobID), "status": .string("completed"),
            "result": .object(["outcome": .string("succeeded"), "output": .object([
                "applicable": .bool(true), "patchSha256": .string(PreviewFixture.patchHash)])])])
        let good = try exchange(path: PreviewFixture.resultPath, status: 200, response: complete)
        let failed = try exchange(path: PreviewFixture.resultPath, status: 503, response: .object(["ok": .bool(false)]))
        try ResponseEvidence.overlappingPatchResults([good, good], jobID: jobID)
        #expect(throws: ProofFailure.self) { try ResponseEvidence.overlappingPatchResults([good], jobID: jobID) }
        #expect(throws: ProofFailure.self) { try ResponseEvidence.overlappingPatchResults([good, failed], jobID: jobID) }
    }
}
