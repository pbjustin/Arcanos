import Foundation
import Testing
@testable import ArcanosKit

private struct TemporaryOperationFile: Sendable {
    let directory: URL
    private let temporaryRoot: URL
    var fileURL: URL { directory.appendingPathComponent("application-support/operations.json") }
    var persistence: FileOperationPersistence { FileOperationPersistence(fileURL: fileURL) }

    init() throws {
        temporaryRoot = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        directory = temporaryRoot.appendingPathComponent("ArcanosOperationTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }

    func remove() throws {
        let resolved = directory.resolvingSymlinksInPath()
        guard resolved.deletingLastPathComponent() == temporaryRoot,
              resolved.lastPathComponent.hasPrefix("ArcanosOperationTests-") else {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        try FileManager.default.removeItem(at: resolved)
    }
}

@Suite("Operation recovery with real files")
struct OperationTrackerPersistenceTests {
    private let origin = URL(string: "https://gateway.example")!
    private let otherOrigin = URL(string: "https://other-gateway.example")!
    private let deviceA = "11111111-1111-4111-8111-111111111111"
    private let deviceB = "22222222-2222-4222-8222-222222222222"
    private let jobID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let instant = Date(timeIntervalSince1970: 1_800_000_000)

    @Test("prunes terminal metadata after the exact retention boundary and keeps unresolved work")
    func retentionSurvivesFileReload() async throws {
        let file = try TemporaryOperationFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let retention: TimeInterval = 60
        let writer = OperationTracker(persistence: file.persistence, retention: retention, now: { instant })
        var records: [TrackedOperation] = []
        for key in ["terminal", "prepared", "uncertain", "accepted", "observing"] {
            let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
                displaySummary: "Remote request", createdAt: instant, idempotencyKey: key)
            try await writer.prepare(operation)
            records.append(operation)
        }
        try await writer.accept(records[0].id, jobID: jobID, backendStatus: "completed")
        try await writer.markSubmissionUncertain(records[2].id)
        try await writer.accept(records[3].id, jobID: UUID().uuidString, backendStatus: "queued")
        let observingJobID = UUID().uuidString
        try await writer.accept(records[4].id, jobID: observingJobID, backendStatus: "queued")
        try await writer.observe(records[4].id, jobID: observingJobID, backendStatus: "pending", terminal: false)

        // No earlier tracker is used again after opening its replacement.
        let atBoundary = OperationTracker(persistence: file.persistence, retention: retention,
            now: { instant.addingTimeInterval(retention) })
        let retainedAtBoundary = try await atBoundary.operations(for: partition)
        #expect(Set(retainedAtBoundary.map(\.id)) == Set(records.map(\.id)))
        let afterBoundary = OperationTracker(persistence: file.persistence, retention: retention,
            now: { instant.addingTimeInterval(retention + 1) })
        let retained = try await afterBoundary.operations(for: partition)
        #expect(Set(retained.map(\.localState)) == [.prepared, .submissionUncertain, .accepted, .observing])
        #expect(Set(retained.map(\.id)) == Set(records.dropFirst().map(\.id)))
        let persisted = try JSONDecoder().decode([TrackedOperation].self, from: Data(contentsOf: file.fileURL))
        #expect(Set(persisted.map(\.id)) == Set(retained.map(\.id)))
        let reloaded = try await OperationTracker(persistence: file.persistence, retention: retention,
            now: { instant.addingTimeInterval(retention + 1) }).operations(for: partition)
        #expect(Set(reloaded.map(\.id)) == Set(retained.map(\.id)))
    }

    @Test("partition removal survives reload and preserves other devices and origins")
    func removeAllIsDurablyPartitionScoped() async throws {
        let file = try TemporaryOperationFile()
        defer { try? file.remove() }
        #expect(!FileManager.default.fileExists(atPath: file.fileURL.deletingLastPathComponent().path))
        let first = try OperationPartition(origin: origin, deviceID: deviceA)
        let otherDevice = try OperationPartition(origin: origin, deviceID: deviceB)
        let otherGateway = try OperationPartition(origin: otherOrigin, deviceID: deviceA)
        let tracker = OperationTracker(persistence: file.persistence, now: { instant })
        var operations: [TrackedOperation] = []
        for partition in [first, otherDevice, otherGateway] {
            let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
                displaySummary: "Remote request", createdAt: instant, idempotencyKey: "same-key-separate-partitions")
            try await tracker.prepare(operation)
            operations.append(operation)
        }
        try await tracker.accept(operations[0].id, jobID: jobID, backendStatus: "queued")
        let canonicalFirst = try OperationPartition(origin: URL(string: "https://GATEWAY.EXAMPLE:443/")!, deviceID: deviceA)
        try await tracker.removeAll(for: canonicalFirst)

        let restored = OperationTracker(persistence: file.persistence, now: { instant })
        #expect(try await restored.operations(for: first).isEmpty)
        #expect(try await restored.operations(for: otherDevice) == [operations[1]])
        #expect(try await restored.operations(for: otherGateway) == [operations[2]])
        let onDisk = try JSONDecoder().decode([TrackedOperation].self, from: Data(contentsOf: file.fileURL))
        #expect(Set(onDisk.map(\.id)) == Set(operations.dropFirst().map(\.id)))
    }

    @Test("truncated and invalid-state files fail closed without replacing recovery bytes", arguments: [false, true])
    func damagedFileIsPreserved(invalidState: Bool) async throws {
        let file = try TemporaryOperationFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        var operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "damaged-file")
        let writer = OperationTracker(persistence: file.persistence, now: { instant })
        try await writer.prepare(operation)
        let damaged: Data
        if invalidState {
            operation.localState = .terminal // A terminal record without a job is invalid even when JSON is intact.
            damaged = try JSONEncoder().encode([operation])
        } else {
            damaged = Data(try Data(contentsOf: file.fileURL).dropLast())
        }
        try damaged.write(to: file.fileURL)

        let restored = OperationTracker(persistence: file.persistence, now: { instant })
        await #expect(throws: OperationTrackingError.corruptStore) { try await restored.operations(for: partition) }
        let replacement = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Another request", createdAt: instant, idempotencyKey: "replacement")
        await #expect(throws: OperationTrackingError.corruptStore) { try await restored.prepare(replacement) }
        await #expect(throws: OperationTrackingError.corruptStore) { try await restored.removeAll(for: partition) }
        #expect(try Data(contentsOf: file.fileURL) == damaged)
    }

    @Test("a failed real file replacement does not publish a tracker mutation")
    func failedFileReplacementPreservesActorState() async throws {
        let file = try TemporaryOperationFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "failed-replacement")
        let tracker = OperationTracker(persistence: file.persistence, now: { instant })
        try await tracker.prepare(operation)
        let before = try Data(contentsOf: file.fileURL)
        let storageDirectory = file.fileURL.deletingLastPathComponent().resolvingSymlinksInPath()
        try #require(storageDirectory.deletingLastPathComponent() == file.directory.resolvingSymlinksInPath())
        let backup = storageDirectory.appendingPathComponent("previous.json")
        let blocker = file.fileURL.appendingPathComponent("nonempty-directory-marker")
        // A nonempty directory at the destination fails for privileged test runners too;
        // chmod-based failures can disappear when Linux tests run as root.
        try FileManager.default.moveItem(at: file.fileURL, to: backup)
        try FileManager.default.createDirectory(at: file.fileURL, withIntermediateDirectories: false)
        let marker = Data("fixture".utf8)
        try marker.write(to: blocker)
        await #expect(throws: (any Error).self) {
            try await tracker.accept(operation.id, jobID: jobID, backendStatus: "queued")
        }
        // Shared storage must be read afresh: a cached snapshot cannot conceal an
        // unavailable file or a different process's updates.
        await #expect(throws: (any Error).self) { try await tracker.operations(for: partition) }
        #expect(try Data(contentsOf: backup) == before)
        #expect(try Data(contentsOf: blocker) == marker)

        try FileManager.default.removeItem(at: file.fileURL)
        try FileManager.default.moveItem(at: backup, to: file.fileURL)
        let restored = OperationTracker(persistence: file.persistence, now: { instant })
        #expect(try await restored.operations(for: partition) == [operation])
        try await tracker.accept(operation.id, jobID: jobID, backendStatus: "queued")
        let accepted = try await OperationTracker(persistence: file.persistence, now: { instant }).operations(for: partition)
        #expect(accepted.first?.backendJobID == jobID)
        #expect(accepted.first?.localState == .accepted)
    }

    @Test("recovered jobs reject pre-operation and cross-origin hints without altering the file")
    func notificationBoundaryUsesRecoveredOwnership() async throws {
        let file = try TemporaryOperationFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceA)
        let foreignPartition = try OperationPartition(origin: otherOrigin, deviceID: deviceA)
        let operation = try TrackedOperation(partition: partition, kind: .remoteAI,
            displaySummary: "Remote request", createdAt: instant, idempotencyKey: "notification")
        let writer = OperationTracker(persistence: file.persistence, now: { instant })
        try await writer.prepare(operation)
        try await writer.accept(operation.id, jobID: jobID, backendStatus: "queued")
        let recovered = try await OperationTracker(persistence: file.persistence, now: { instant }).operations(for: partition)
        let before = try Data(contentsOf: file.fileURL)
        let inbox = CompletionHintInbox(now: { instant })
        let eventID = UUID()
        let early = try CompletionNotificationHint(operationID: operation.id, jobID: jobID,
            partition: partition, eventID: eventID, occurredAt: instant.addingTimeInterval(-1))
        let foreign = try CompletionNotificationHint(operationID: operation.id, jobID: jobID,
            partition: foreignPartition, eventID: eventID, occurredAt: instant)
        let valid = try CompletionNotificationHint(operationID: operation.id, jobID: jobID,
            partition: partition, eventID: eventID, occurredAt: instant)
        #expect(await inbox.receive(early, operations: recovered) == nil)
        #expect(await inbox.receive(foreign, operations: recovered) == nil)
        #expect(await inbox.receive(valid, operations: recovered) == operation.id)
        #expect(await inbox.receive(valid, operations: recovered) == nil)
        #expect(try Data(contentsOf: file.fileURL) == before)
        #expect(recovered.first?.localState == .accepted)
    }
}
