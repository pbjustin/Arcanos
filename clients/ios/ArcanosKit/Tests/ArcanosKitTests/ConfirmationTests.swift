import XCTest
@testable import ArcanosKit

private struct ConfirmationCredential: GatewayCredentialProvider {
    func credential(for origin: URL) async throws -> GatewayCredential? {
        GatewayCredential(token: "synthetic-unit-test-only", origin: origin, expiresAt: .distantFuture)
    }
}

private actor ConfirmationTransport: GatewayTransport {
    enum Mode: Sendable { case accept, rechallenge, fail, refusedInner, pending }
    let mode: Mode
    private var requests: [GatewayRequest] = []
    init(_ mode: Mode = .accept) { self.mode = mode }
    func recorded() -> [GatewayRequest] { requests }
    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        requests.append(request)
        if requests.count == 1 || mode == .rechallenge {
            return GatewayResponse(statusCode: 403, data: Data(#"{"code":"CONFIRMATION_REQUIRED","confirmationRequired":true,"confirmationChallenge":{"id":"synthetic-challenge","expiresAt":"2099-01-01T00:00:00.000Z"}}"#.utf8))
        }
        if mode == .fail { throw GatewayError.unavailable }
        if mode == .refusedInner {
            return GatewayResponse(statusCode: 200, data: Data(#"{"ok":true,"result":{"ok":false,"persisted":false,"error":{"code":"FAILED"}}}"#.utf8))
        }
        return GatewayResponse(statusCode: 200, data: Data(#"{"ok":true,"result":{"ok":true,"accepted":true,"persisted":true,"jobId":"11111111-1111-4111-8111-111111111111","status":"queued"}}"#.utf8))
    }
}

@MainActor final class ConfirmationTests: XCTestCase {
    private func client(_ transport: ConfirmationTransport) throws -> CapabilityClient {
        CapabilityClient(gateway: try GatewayClient(baseURL: URL(string: "https://tests.arcanos.invalid")!,
                                                     credentials: ConfirmationCredential(), transport: transport))
    }

    private func begin(_ coordinator: ConfirmationCoordinator, client: CapabilityClient) async throws -> PendingApproval {
        let request = try client.prepare(id: "ARCANOS:LOCAL_AGENT", action: "tests.run",
                                         payload: .object(["profile": .string("typescript-unit")]), idempotencyKey: "stable-test-key")
        guard case .approval(let pending) = try await coordinator.submit(request, summary: "Approve tests.run?") else {
            throw GatewayError.invalidResponse
        }
        return pending
    }

    func testApprovalRetriesExactlyOnceAndOnlyAppendsToken() async throws {
        let transport = ConfirmationTransport(), client = try client(transport)
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let pending = try await begin(coordinator, client: client)
        let before = await transport.recorded()
        XCTAssertEqual(before.count, 1)
        _ = try await coordinator.approve(pending.id)
        do { _ = try await coordinator.approve(pending.id); XCTFail("Repeated approval accepted") } catch ConfirmationError.notPending {}
        let requests = await transport.recorded()
        XCTAssertEqual(requests.count, 2)
        XCTAssertEqual(requests[0].url, requests[1].url)
        XCTAssertEqual(requests[0].method, requests[1].method)
        XCTAssertEqual(requests[0].headers, requests[1].headers)
        let original = try XCTUnwrap(requests[0].body), approved = try XCTUnwrap(requests[1].body)
        XCTAssertTrue(approved.starts(with: original.dropLast()))
        var retryObject = try JSONDecoder().decode([String: JSONValue].self, from: approved)
        XCTAssertEqual(retryObject.removeValue(forKey: "confirmation_token"), .string("synthetic-challenge"))
        XCTAssertEqual(retryObject, try JSONDecoder().decode([String: JSONValue].self, from: original))
    }

    func testDeclineAndUnknownApprovalNeverRetry() async throws {
        let transport = ConfirmationTransport(), client = try client(transport)
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let pending = try await begin(coordinator, client: client)
        do { _ = try await coordinator.approve(UUID()); XCTFail("Unknown approval accepted") } catch {}
        let cancelled = await coordinator.cancel(pending.id)
        XCTAssertTrue(cancelled)
        do { _ = try await coordinator.approve(pending.id); XCTFail("Cancelled approval accepted") } catch {}
        let count = await transport.recorded().count
        XCTAssertEqual(count, 1)
    }

    func testRetryChallengeStopsWithoutStoringAnotherApproval() async throws {
        let transport = ConfirmationTransport(.rechallenge), client = try client(transport)
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let pending = try await begin(coordinator, client: client)
        do { _ = try await coordinator.approve(pending.id); XCTFail("Repeated challenge accepted") } catch ConfirmationError.repeatedChallenge {}
        do { _ = try await coordinator.approve(pending.id); XCTFail("Third request sent") } catch {}
        let count = await transport.recorded().count
        XCTAssertEqual(count, 2)
    }

    func testUncertainRetryFailureConsumesApproval() async throws {
        let transport = ConfirmationTransport(.fail), client = try client(transport)
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let pending = try await begin(coordinator, client: client)
        do { _ = try await coordinator.approve(pending.id); XCTFail("Failure expected") } catch {}
        do { _ = try await coordinator.approve(pending.id); XCTFail("Automatic retry allowed") } catch {}
        let count = await transport.recorded().count
        XCTAssertEqual(count, 2)
    }

    func testConcurrentApprovalsOnlySendOneRetry() async throws {
        let transport = ConfirmationTransport(), client = try client(transport)
        let coordinator = ConfirmationCoordinator(capabilities: client)
        let pending = try await begin(coordinator, client: client)
        async let first = Self.attemptApproval(coordinator, id: pending.id)
        async let second = Self.attemptApproval(coordinator, id: pending.id)
        let outcomes = await [first, second]
        XCTAssertEqual(outcomes.filter { $0 }.count, 1)
        let count = await transport.recorded().count
        XCTAssertEqual(count, 2)
    }

    func testOuterSuccessWithFailedEnqueueIsNotSuccess() async throws {
        let transport = ConfirmationTransport(.refusedInner), client = try client(transport)
        let session = ArcanosSession(router: AIRouter(), capabilities: client)
        let initial = await session.ask("Run tests")
        let result = await session.approve(try XCTUnwrap(initial.approvalID))
        XCTAssertEqual(result.kind, .failure)
        XCTAssertNil(result.jobID)
    }

    func testAcceptedJobIsPendingNotCompleted() async throws {
        let transport = ConfirmationTransport(), client = try client(transport)
        let session = ArcanosSession(router: AIRouter(), capabilities: client)
        let initial = await session.ask("Run tests")
        let result = await session.approve(try XCTUnwrap(initial.approvalID))
        XCTAssertEqual(result.kind, .pending)
        XCTAssertNotNil(result.jobID)
    }

    func testApplyRequiresActualPreviewAndCannotBeInferredByModel() async {
        let result = await ArcanosSession(router: AIRouter()).ask("Apply that patch")
        XCTAssertEqual(result.kind, .failure)
        XCTAssertTrue(result.text.contains("preview"))
    }

    private nonisolated static func attemptApproval(_ coordinator: ConfirmationCoordinator, id: UUID) async -> Bool {
        do { _ = try await coordinator.approve(id); return true } catch { return false }
    }
}
