import ArcanosKit
import Foundation

/// Negative scenarios need the intended received server response, not merely a client failure.
enum ResponseEvidence {
    static func json(_ response: GatewayResponse) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: response.data)
    }

    static func devicePolicy(_ response: GatewayResponse, prNumber: Int, sourceCommit: String) throws {
        let expected: JSONValue = .object([
            "ok": .bool(true), "synthetic": .bool(true),
            "proofVersion": .string(PreviewFixture.devicePolicyVersion),
            "prNumber": .integer(Int64(prNumber)), "sourceCommit": .string(sourceCommit),
            "checks": .object([
                "grantAndOriginValidation": .bool(true), "credentialExpiryAndRenewal": .bool(true),
                "revocationAndAudience": .bool(true), "ownerIsolation": .bool(true),
                "missingOwnerDenied": .bool(true), "requesterIdempotencyIsolation": .bool(true),
                "operatorIdempotencyCompatibility": .bool(true)
            ]),
            "boundaries": .object([
                "grantSchema": .bool(true), "credentialStatePolicy": .bool(true),
                "deviceJobOwnership": .bool(true), "requesterIdempotency": .bool(true)
            ]),
            "protectedEffectsEnabled": .bool(false)
        ])
        try require(response.statusCode == 200, "DEVICE_POLICY_HTTP_STATUS")
        try require(try json(response) == expected, "DEVICE_POLICY_CONTRACT_MISMATCH")
    }

    static func aiSequence(_ exchanges: [ObservedTransport.Exchange], terminalStatus: String) throws {
        try require(exchanges.count == 3, "AI_POLL_SEQUENCE_COUNT")
        try require(exchanges.map { $0.request.url.path } == [PreviewFixture.createPath, PreviewFixture.resultPath, PreviewFixture.resultPath]
                    && exchanges.allSatisfy { $0.request.method == "POST" }
                    && exchanges.map { $0.response.statusCode } == [202, 200, 200], "AI_POLL_HTTP_SEQUENCE")
        let receipt = try json(exchanges[0].response)
        let pending = try json(exchanges[1].response)
        let terminal = try json(exchanges[2].response)
        guard let terminalModel = try? JSONDecoder().decode(JobResultResponse.self, from: exchanges[2].response.data),
              terminalModel.resultEndpoint == PreviewFixture.resultPath else {
            throw ProofFailure("TERMINAL_JOB_DTO_INVALID")
        }
        guard let jobID = receipt["jobId"]?.stringValue, UUID(uuidString: jobID) != nil else { throw ProofFailure("AI_SEQUENCE_JOB_ID") }
        try require(receipt["ok"] == .bool(true) && pending["ok"] == .bool(true) && terminal["ok"] == .bool(true)
                    && pending["status"] == .string("pending") && terminal["status"] == .string(terminalStatus)
                    && pending["jobId"] == .string(jobID) && terminal["jobId"] == .string(jobID), "AI_POLL_STATES_MISMATCH")
        for exchange in exchanges.dropFirst() {
            guard let body = exchange.request.body else { throw ProofFailure("AI_SEQUENCE_REQUEST_BODY") }
            try require(try JSONDecoder().decode(JSONValue.self, from: body)["jobId"] == .string(jobID), "AI_SEQUENCE_REQUEST_JOB_ID")
        }
        if terminalStatus == "failed" {
            try require(terminal["error"]?["code"] == .string("IOS_PREVIEW_JOB_FAILED") && terminal["result"] == .null, "FAILED_JOB_ENVELOPE_MISMATCH")
        }
    }

    static func unavailable(_ exchanges: [ObservedTransport.Exchange]) throws {
        try require(exchanges.count == 1, "UNAVAILABLE_RESPONSE_MISSING")
        let response = exchanges[0]
        let value = try json(response.response)
        try require(response.request.url.path == PreviewFixture.createPath && response.request.method == "POST"
                    && response.response.statusCode == 503 && value["ok"] == .bool(false)
                    && value["error"]?["code"] == .string("IOS_PREVIEW_UNAVAILABLE")
                    && value["error"]?["message"] == .string("SYNTHETIC_IOS_PREVIEW_PRIVATE_ERROR_MARKER"), "UNAVAILABLE_ENVELOPE_MISMATCH")
    }

    static func overlappingPatchResults(_ exchanges: [ObservedTransport.Exchange], jobID: String) throws {
        try require(exchanges.count == 2, "PATCH_RESULT_RESPONSE_COUNT")
        var previous: JSONValue?
        for exchange in exchanges {
            let value = try json(exchange.response)
            guard let body = exchange.request.body else { throw ProofFailure("PATCH_RESULT_REQUEST_BODY") }
            try require(exchange.request.method == "POST" && exchange.request.url.path == PreviewFixture.resultPath
                        && exchange.response.statusCode == 200 && value["ok"] == .bool(true)
                        && value["status"] == .string("completed") && value["jobId"] == .string(jobID)
                        && value["result"]?["outcome"] == .string("succeeded")
                        && value["result"]?["output"]?["applicable"] == .bool(true)
                        && value["result"]?["output"]?["patchSha256"] == .string(PreviewFixture.patchHash), "PATCH_RESULT_ENVELOPE_MISMATCH")
            try require(try JSONDecoder().decode(JSONValue.self, from: body)["jobId"] == .string(jobID), "PATCH_RESULT_REQUEST_JOB_ID")
            if let previous { try require(previous == value, "PATCH_RESULT_RESPONSE_MISMATCH") }
            previous = value
        }
    }
}
