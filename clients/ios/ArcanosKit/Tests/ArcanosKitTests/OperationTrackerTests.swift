import Foundation
import Testing
@testable import ArcanosKit

private final class MemoryOperationPersistence: OperationPersistence, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?
    func load() throws -> Data? { lock.withLock { value } }
    func replace(with data: Data) throws { lock.withLock { value = data } }
}

@Suite("Durable operation tracking")
struct OperationTrackerTests {
    private let origin = URL(string: "https://gateway.example")!
    private let deviceA = "11111111-1111-4111-8111-111111111111"
    private let deviceB = "22222222-2222-4222-8222-222222222222"
    private let instant = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("restores accepted jobs without creating a second operation")
    func restoresAcrossTrackerInstances() async throws {
        let persistence = MemoryOperationPersistence()
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote ARCANOS request", createdAt: instant, idempotencyKey: "semantic-key")
        let first = OperationTracker(persistence: persistence, now: { instant })
        try await first.prepare(operation)
        try await first.accept(operation.id, jobID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", backendStatus: "queued")

        let restored = try await OperationTracker(persistence: persistence, now: { instant }).operations(for: partition)
        #expect(restored.count == 1)
        #expect(restored.first?.localState == .accepted)
        #expect(restored.first?.idempotencyKey == "semantic-key")
    }

    @Test("keeps uncertain submission distinct and refuses idempotency collisions")
    func uncertainSubmissionDoesNotReplay() async throws {
        let persistence = MemoryOperationPersistence()
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .capability,
            displaySummary: "Run approved tests", createdAt: instant, idempotencyKey: "one-operation")
        let tracker = OperationTracker(persistence: persistence, now: { instant })
        try await tracker.prepare(operation)
        try await tracker.markSubmissionUncertain(operation.id)
        await #expect(throws: GatewayError.self) { try await tracker.prepare(operation) }
        #expect(try await tracker.operations(for: partition).first?.localState == .submissionUncertain)
    }

    @Test("isolates device partitions and rejects ambiguous recent voice references")
    func partitionAndReferenceSafety() async throws {
        let tracker = OperationTracker(persistence: MemoryOperationPersistence(), now: { instant })
        let firstPartition = try OperationPartition(origin: origin, deviceID: deviceA)
        let secondPartition = try OperationPartition(origin: origin, deviceID: deviceB)
        for (key, summary) in [("one", "First job"), ("two", "Second job")] {
            try await tracker.prepare(TrackedOperation(partition: firstPartition, kind: .remoteAI,
                displaySummary: summary, createdAt: instant, idempotencyKey: key))
        }
        #expect(try await tracker.operations(for: secondPartition).isEmpty)
        await #expect(throws: OperationTrackingError.ambiguousReference) {
            try await tracker.resolveRecent(for: firstPartition)
        }
    }

    @Test("rejects a status response for a different job handle")
    func rejectsMismatchedObservation() async throws {
        let tracker = OperationTracker(persistence: MemoryOperationPersistence(), now: { instant })
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "key")
        try await tracker.prepare(operation)
        try await tracker.accept(operation.id, jobID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", backendStatus: "queued")
        await #expect(throws: GatewayError.self) {
            try await tracker.observe(operation.id, jobID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", backendStatus: "completed", terminal: true)
        }
    }

    @Test("notification hints are deduplicated and cannot cross a device partition")
    func notificationHintsAreNonAuthoritative() async throws {
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let other = try OperationPartition(origin: origin, deviceID: deviceB)
        var operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "notification-key")
        operation.backendJobID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        operation.localState = .accepted
        let event = UUID()
        let inbox = CompletionHintInbox(now: { instant })
        let valid = try CompletionNotificationHint(operationID: operation.id, jobID: operation.backendJobID!,
            partition: partition, eventID: event, occurredAt: instant)
        #expect(await inbox.receive(valid, operations: [operation]) == operation.id)
        #expect(await inbox.receive(valid, operations: [operation]) == nil)
        let foreign = try CompletionNotificationHint(operationID: operation.id, jobID: operation.backendJobID!,
            partition: other, eventID: UUID(), occurredAt: instant)
        #expect(await inbox.receive(foreign, operations: [operation]) == nil)
    }
}
