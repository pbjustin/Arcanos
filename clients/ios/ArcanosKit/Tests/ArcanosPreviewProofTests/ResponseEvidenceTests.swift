import ArcanosKit
import Foundation
import Testing
@testable import ArcanosPreviewProof

struct ResponseEvidenceTests {
    private let jobID = "14950000-0000-4000-8000-000000000001"

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
