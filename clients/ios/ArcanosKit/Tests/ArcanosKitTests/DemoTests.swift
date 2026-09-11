import Foundation
import Testing
@testable import ArcanosKit

struct DemoTests {
    @Test func sessionRequiresApprovalBeforeTheSyntheticJobCanComplete() async throws {
        let session = try DemoGateway.makeSession()
        let challenge = await session.ask("Run tests")
        #expect(challenge.kind == .confirmationRequired)
        #expect(challenge.jobID == nil)
        let approvalID = try #require(challenge.approvalID)

        let accepted = await session.approve(approvalID)
        #expect(accepted.kind == .pending)
        let jobID = try #require(accepted.jobID)
        let completed = await session.checkJob(jobID)
        #expect(completed.kind == .answer)
        #expect(completed.text.contains("tests passed"))

        let replay = await session.approve(approvalID)
        #expect(replay.kind == .failure)
        #expect(replay.jobID == nil)
    }

    @Test func decliningAndUnknownApprovalHandlesCannotExecute() async throws {
        let session = try DemoGateway.makeSession()
        let challenge = await session.ask("Run tests")
        let approvalID = try #require(challenge.approvalID)
        let unrelated = await session.approve(UUID())
        #expect(unrelated.kind == .failure)
        #expect(unrelated.jobID == nil)
        let cancelled = await session.cancel(approvalID)
        #expect(cancelled.kind == .cancelled)
        let afterCancellation = await session.approve(approvalID)
        #expect(afterCancellation.kind == .failure)
        #expect(afterCancellation.jobID == nil)
        let unknownJob = await session.checkJob(UUID().uuidString)
        #expect(unknownJob.kind == .failure)
    }

    @Test func syntheticAIExercisesCreationAndPendingToCompletedPolling() async throws {
        let session = try DemoGateway.makeSession()
        let response = await session.ask("Explain recursion")
        #expect(response.kind == .answer)
        #expect(response.text.contains("Synthetic demo"))
    }

    @Test func syntheticGatewayRejectsChangedPayloadAndConsumesTheChallenge() async throws {
        let transport = DemoGatewayTransport()
        let original = try request()
        let pending = try await transport.send(original)
        #expect(pending.statusCode == 403)
        let challenge = try JSONDecoder().decode(ConfirmationRequiredResponse.self, from: pending.data)

        let changed = try request(challengeID: challenge.confirmationChallenge.id,
                                  extraPayload: ["unapproved": .bool(true)])
        let denied = try await transport.send(changed)
        #expect(denied.statusCode == 403)
        // An unsupported payload cannot execute, even if it carries a genuine challenge.
        let deniedBody = try JSONDecoder().decode(ErrorResponse.self, from: denied.data)
        #expect(deniedBody.ok == false)
        let replay = try await transport.send(request(challengeID: challenge.confirmationChallenge.id))
        #expect(replay.statusCode == 403)
    }

    @Test func syntheticGatewayRejectsChangedIdentityAndChallengeReplay() async throws {
        let transport = DemoGatewayTransport()
        let pending = try await transport.send(request())
        let challenge = try JSONDecoder().decode(ConfirmationRequiredResponse.self, from: pending.data)
        let challengeID = challenge.confirmationChallenge.id
        let changed = try request(challengeID: challengeID, idempotencyKey: "different-request")
        let denied = try await transport.send(changed)
        #expect(denied.statusCode == 403)
        let replay = try await transport.send(request(challengeID: challengeID))
        #expect(replay.statusCode == 403)
    }

    @Test func syntheticGatewayAllowsOnlyOneExactRetry() async throws {
        let transport = DemoGatewayTransport()
        let pending = try await transport.send(request())
        let challenge = try JSONDecoder().decode(ConfirmationRequiredResponse.self, from: pending.data)
        let retry = try request(challengeID: challenge.confirmationChallenge.id)
        let accepted = try await transport.send(retry)
        #expect(accepted.statusCode == 200)
        let receipt = try JSONDecoder().decode(CapabilityRunResponse.self, from: accepted.data)
        #expect(receipt.result["accepted"]?.boolValue == true)
        #expect(receipt.result["persisted"]?.boolValue == true)
        #expect(receipt.result["status"]?.stringValue == "pending")
        let replay = try await transport.send(retry)
        #expect(replay.statusCode == 403)
    }

    @Test func syntheticGatewayRejectsUnknownTokensAndOtherOrigins() async throws {
        let transport = DemoGatewayTransport()
        let denied = try await transport.send(request(challengeID: UUID().uuidString))
        #expect(denied.statusCode == 403)
        let original = try request()
        let foreign = GatewayRequest(url: URL(string: "https://example.invalid/gpt-access/jobs/create")!,
                                     method: original.method, headers: original.headers, body: original.body)
        let rejected = try await transport.send(foreign)
        #expect(rejected.statusCode == 403)
        let error = try JSONDecoder().decode(ErrorResponse.self, from: rejected.data)
        #expect(error.error.code == "DEMO_ORIGIN_DENIED")
    }

    private func request(challengeID: String? = nil, idempotencyKey: String = "synthetic-test-request",
                         extraPayload: [String: JSONValue] = [:]) throws -> GatewayRequest {
        var payload: [String: JSONValue] = ["profile": .string("typescript-unit")]
        payload.merge(extraPayload, uniquingKeysWith: { _, replacement in replacement })
        let body = CapabilityRunRequest(action: "tests.run", payload: .object(payload), confirmationToken: challengeID)
        return GatewayRequest(
            url: URL(string: "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run",
                     relativeTo: DemoGateway.origin)!.absoluteURL,
            method: "POST", headers: ["Authorization": "Bearer synthetic-demo-test-only", "Idempotency-Key": idempotencyKey],
            body: try JSONEncoder().encode(body)
        )
    }
}
