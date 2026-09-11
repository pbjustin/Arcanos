import Foundation
import Testing
@testable import ArcanosKit

private final class MemoryOperationPersistence: OperationPersistence, @unchecked Sendable {
    private let lock = NSLock()
    private var value: Data?
    private var rejectNextWrite = false
    func load() throws -> Data? { lock.withLock { value } }
    func replace(with data: Data) throws {
        try lock.withLock {
            if rejectNextWrite {
                rejectNextWrite = false
                throw CocoaError(.fileWriteNoPermission)
            }
            value = data
        }
    }
    func failNextWrite() { lock.withLock { rejectNextWrite = true } }
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

    @Test("accepts Local Agent pending and deduplicated terminal receipts", arguments: ["pending", "cancelled", "expired"])
    func localAgentAcceptance(status: String) async throws {
        let tracker = OperationTracker(persistence: MemoryOperationPersistence(), now: { instant })
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .capability,
            displaySummary: "Run approved tests", createdAt: instant, idempotencyKey: "local-agent")
        try await tracker.prepare(operation)
        try await tracker.accept(operation.id, jobID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", backendStatus: status)
        let stored = try #require(try await tracker.operations(for: partition).first)
        #expect(stored.backendStatus == status)
        #expect(stored.localState == (status == "pending" ? .accepted : .terminal))
    }

    @Test("keeps terminal results and accepted handles stable under delayed callbacks")
    func acceptedIdentityAndTerminalStateAreStable() async throws {
        let persistence = MemoryOperationPersistence()
        let tracker = OperationTracker(persistence: persistence, now: { instant })
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "stable-handle")
        let jobID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        try await tracker.prepare(operation)
        try await tracker.accept(operation.id, jobID: jobID, backendStatus: "queued")
        await #expect(throws: GatewayError.invalidResponse) {
            try await tracker.accept(operation.id, jobID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", backendStatus: "queued")
        }
        try await tracker.observe(operation.id, jobID: jobID, backendStatus: "pending", terminal: false)
        try await tracker.accept(operation.id, jobID: jobID, backendStatus: "queued")
        #expect(try await tracker.operations(for: partition).first?.localState == .observing)
        try await tracker.observe(operation.id, jobID: jobID, backendStatus: "completed", terminal: true)
        let terminalData = try persistence.load()
        try await tracker.observe(operation.id, jobID: jobID, backendStatus: "pending", terminal: false)
        try await tracker.accept(operation.id, jobID: jobID, backendStatus: "running")
        try await tracker.markSubmissionUncertain(operation.id)
        #expect(try persistence.load() == terminalData)
        let restored = try await OperationTracker(persistence: persistence, now: { instant }).operations(for: partition)
        #expect(restored.first?.backendJobID == jobID)
        #expect(restored.first?.backendStatus == "completed")
        #expect(restored.first?.localState == .terminal)
    }

    @Test("rejects unknown or contradictory observations", arguments: ["pending", "completed", "unknown"])
    func rejectsInvalidObservation(status: String) async throws {
        let persistence = MemoryOperationPersistence()
        let tracker = OperationTracker(persistence: persistence, now: { instant })
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "invalid-observation")
        let jobID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
        try await tracker.prepare(operation)
        try await tracker.accept(operation.id, jobID: jobID, backendStatus: "queued")
        let before = try persistence.load()
        await #expect(throws: GatewayError.invalidResponse) {
            try await tracker.observe(operation.id, jobID: jobID, backendStatus: status, terminal: status != "completed")
        }
        #expect(try persistence.load() == before)
    }

    @Test("rejects operation UUID collisions across keys and partitions", arguments: [false, true])
    func rejectsDuplicateOperationIDs(otherPartition: Bool) async throws {
        let tracker = OperationTracker(persistence: MemoryOperationPersistence(), now: { instant })
        let firstPartition = try OperationPartition(origin: origin, deviceID: deviceA)
        let secondPartition = try OperationPartition(origin: origin, deviceID: otherPartition ? deviceB : deviceA)
        let first = try TrackedOperation(partition: firstPartition, kind: .remoteAI,
            displaySummary: "First request", createdAt: instant, idempotencyKey: "first")
        let duplicate = try TrackedOperation(id: first.id, partition: secondPartition, kind: .remoteAI,
            displaySummary: "Second request", createdAt: instant, idempotencyKey: "second")
        try await tracker.prepare(first)
        await #expect(throws: GatewayError.invalidRequest) { try await tracker.prepare(duplicate) }
        #expect(try await tracker.operations(for: firstPartition) == [first])
        if otherPartition { #expect(try await tracker.operations(for: secondPartition).isEmpty) }
    }

    @Test("fails closed on restored identity collisions", arguments: [false, true])
    func rejectsRestoredIdentityCollisions(duplicateKey: Bool) async throws {
        let persistence = MemoryOperationPersistence()
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let first = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "First request", createdAt: instant, idempotencyKey: "first")
        let duplicate = try TrackedOperation(id: duplicateKey ? UUID() : first.id, partition: partition, kind: .remoteAI,
            displaySummary: "Second request", createdAt: instant, idempotencyKey: duplicateKey ? "first" : "second")
        let data = try JSONEncoder().encode([first, duplicate])
        try persistence.replace(with: data)
        let tracker = OperationTracker(persistence: persistence, now: { instant })
        await #expect(throws: OperationTrackingError.corruptStore) { try await tracker.operations(for: partition) }
        #expect(try persistence.load() == data)
    }

    @Test("validates decoded partitions and job state before restoring", arguments: [false, true])
    func rejectsMalformedRestoredRecords(invalidPartition: Bool) async throws {
        let persistence = MemoryOperationPersistence()
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let decodedPartition = try JSONDecoder().decode(OperationPartition.self,
            from: Data(#"{"origin":"http://gateway.example","deviceID":"not-a-device"}"#.utf8))
        var operation = try TrackedOperation(partition: invalidPartition ? decodedPartition : partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "invalid-record")
        if !invalidPartition { operation.localState = .terminal }
        let data = try JSONEncoder().encode([operation])
        try persistence.replace(with: data)
        let tracker = OperationTracker(persistence: persistence, now: { instant })
        await #expect(throws: OperationTrackingError.corruptStore) { try await tracker.operations(for: partition) }
        #expect(try persistence.load() == data)
    }

    @Test("failed writes preserve both durable and actor state")
    func failedWriteDoesNotPublishMutation() async throws {
        let persistence = MemoryOperationPersistence()
        let tracker = OperationTracker(persistence: persistence, now: { instant })
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "write-failure")
        try await tracker.prepare(operation)
        let before = try persistence.load()
        persistence.failNextWrite()
        await #expect(throws: CocoaError.self) {
            try await tracker.accept(operation.id, jobID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", backendStatus: "queued")
        }
        #expect(try persistence.load() == before)
        #expect(try await tracker.operations(for: partition) == [operation])
        #expect(try await OperationTracker(persistence: persistence, now: { instant }).operations(for: partition) == [operation])
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
