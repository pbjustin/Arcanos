import Foundation

/// A non-secret, authenticated partition used to prevent recovery across devices or Gateway origins.
public struct OperationPartition: Codable, Hashable, Sendable {
    public let origin: String
    public let deviceID: String

    /// Creates a partition from server-issued device identity and a validated HTTPS origin.
    public init(origin: URL, deviceID: String) throws {
        let canonical = try DeviceAuthentication.origin(origin)
        guard UUID(uuidString: deviceID) != nil else { throw GatewayError.invalidConfiguration }
        self.origin = canonical.absoluteString
        self.deviceID = deviceID.lowercased()
    }
}

/// Client presentation state; these values deliberately do not extend backend job status.
public enum LocalOperationState: String, Codable, Sendable {
    case prepared, submissionUncertain, accepted, observing, terminal, dismissed
}

/// Safe operation classification retained without prompts, payloads, credentials, or results.
public enum TrackedOperationKind: String, Codable, Sendable {
    case remoteAI, capability, confirmation, patchPreview, patchApply
}

/// Minimal recovery index entry. The backend remains authoritative for status and result content.
public struct TrackedOperation: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let partition: OperationPartition
    public let kind: TrackedOperationKind
    public let displaySummary: String
    public let createdAt: Date
    public var updatedAt: Date
    public let idempotencyKey: String
    public var backendJobID: String?
    public var backendStatus: String?
    public var localState: LocalOperationState
    public var previewReference: String?

    /// Creates a pre-network record so a crash cannot erase submission uncertainty.
    public init(id: UUID = UUID(), partition: OperationPartition, kind: TrackedOperationKind,
                displaySummary: String, createdAt: Date, idempotencyKey: String) throws {
        let safeSummary = displaySummary.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !safeSummary.isEmpty, safeSummary.utf8.count <= 240,
              !idempotencyKey.isEmpty, idempotencyKey.utf8.count <= 240 else {
            throw GatewayError.invalidRequest
        }
        self.id = id
        self.partition = partition
        self.kind = kind
        self.displaySummary = safeSummary
        self.createdAt = createdAt
        self.updatedAt = createdAt
        self.idempotencyKey = idempotencyKey
        self.localState = .prepared
    }
}

/// Injected persistence boundary used by the tracker and deterministic tests.
public protocol OperationPersistence: Sendable {
    func load() throws -> Data?
    func replace(with data: Data) throws
}

/// Atomic file-backed storage for non-secret operation metadata.
public struct FileOperationPersistence: OperationPersistence {
    public let fileURL: URL

    /// Uses an application-support file supplied by the host; parent directories are created lazily.
    public init(fileURL: URL) { self.fileURL = fileURL }

    public func load() throws -> Data? {
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return nil }
        return try Data(contentsOf: fileURL, options: .mappedIfSafe)
    }

    public func replace(with data: Data) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}

/// Serializes recovery-index changes and enforces authenticated partition isolation.
public actor OperationTracker {
    private let persistence: any OperationPersistence
    private let now: @Sendable () -> Date
    private let retention: TimeInterval
    private var records: [TrackedOperation]?

    /// Creates a tracker; terminal/dismissed metadata expires after the bounded retention interval.
    public init(persistence: any OperationPersistence, retention: TimeInterval = 7 * 24 * 60 * 60,
                now: @escaping @Sendable () -> Date = { Date() }) {
        self.persistence = persistence
        self.retention = retention
        self.now = now
    }

    /// Persists submission intent before transport. Callers must not reuse its key for another operation.
    @discardableResult
    public func prepare(_ operation: TrackedOperation) throws -> UUID {
        var values = try current()
        //audit Assumption: an idempotency key identifies one semantic operation in one security partition; reject collisions rather than guessing.
        guard !values.contains(where: { $0.partition == operation.partition && $0.idempotencyKey == operation.idempotencyKey }) else {
            throw GatewayError.invalidRequest
        }
        values.append(operation)
        try commit(values)
        return operation.id
    }

    /// Records a confirmed backend acceptance without treating acceptance as completion.
    public func accept(_ id: UUID, jobID: String, backendStatus: String) throws {
        guard UUID(uuidString: jobID) != nil, ["queued", "running", "completed", "failed"].contains(backendStatus) else {
            throw GatewayError.invalidResponse
        }
        try update(id) { record in
            record.backendJobID = jobID
            record.backendStatus = backendStatus
            record.localState = backendStatus == "completed" || backendStatus == "failed" ? .terminal : .accepted
        }
    }

    /// Marks a transport outcome ambiguous; this never authorizes automatic replay.
    public func markSubmissionUncertain(_ id: UUID) throws {
        try update(id) { record in
            guard record.backendJobID == nil else { return }
            record.localState = .submissionUncertain
        }
    }

    /// Applies an authorized status read to a known accepted job.
    public func observe(_ id: UUID, jobID: String, backendStatus: String, terminal: Bool) throws {
        try update(id) { record in
            //audit Assumption: response identity must equal the accepted handle; mismatch is untrusted transport data and fails closed.
            guard record.backendJobID == jobID else { throw GatewayError.invalidResponse }
            record.backendStatus = backendStatus
            record.localState = terminal ? .terminal : .observing
        }
    }

    /// Returns only records belonging to the current authenticated device/origin partition.
    public func operations(for partition: OperationPartition) throws -> [TrackedOperation] {
        try prune()
        return try current().filter { $0.partition == partition }.sorted { $0.updatedAt > $1.updatedAt }
    }

    /// Resolves a recent reference only when exactly one non-stale candidate exists.
    public func resolveRecent(for partition: OperationPartition, maximumAge: TimeInterval = 24 * 60 * 60) throws -> TrackedOperation? {
        let candidates = try operations(for: partition).filter {
            $0.localState != .dismissed && now().timeIntervalSince($0.updatedAt) <= maximumAge
        }
        //audit Assumption: implicit voice references are safe only when unambiguous; multiple candidates require clarification.
        guard candidates.count <= 1 else { throw OperationTrackingError.ambiguousReference }
        return candidates.first
    }

    /// Deletes all cached metadata for an unpaired partition; server jobs and results are untouched.
    public func removeAll(for partition: OperationPartition) throws {
        try commit(try current().filter { $0.partition != partition })
    }

    private func update(_ id: UUID, mutation: (inout TrackedOperation) throws -> Void) throws {
        var values = try current()
        guard let index = values.firstIndex(where: { $0.id == id }) else { throw OperationTrackingError.notFound }
        try mutation(&values[index])
        values[index].updatedAt = now()
        try commit(values)
    }

    private func prune() throws {
        let cutoff = now().addingTimeInterval(-retention)
        let values = try current()
        let retained = values.filter { ![.terminal, .dismissed].contains($0.localState) || $0.updatedAt >= cutoff }
        if retained.count != values.count { try commit(retained) }
    }

    private func current() throws -> [TrackedOperation] {
        if let records { return records }
        guard let data = try persistence.load() else { records = []; return [] }
        do {
            let decoded = try JSONDecoder().decode([TrackedOperation].self, from: data)
            records = decoded
            return decoded
        } catch {
            //audit Assumption: corrupt local cache has no authority; surface failure rather than silently discarding recovery evidence.
            throw OperationTrackingError.corruptStore
        }
    }

    private func commit(_ values: [TrackedOperation]) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try persistence.replace(with: encoder.encode(values))
        records = values
    }
}

public enum OperationTrackingError: Error, Equatable, Sendable {
    case notFound, corruptStore, ambiguousReference
}

/// Minimal push payload. It is only a wake/presentation hint and never authoritative job state.
public struct CompletionNotificationHint: Codable, Equatable, Sendable {
    public let operationID: UUID
    public let jobID: String
    public let partition: OperationPartition
    public let eventID: UUID
    public let occurredAt: Date

    /// Validates safe identifiers; callers must still perform an authenticated result read.
    public init(operationID: UUID, jobID: String, partition: OperationPartition,
                eventID: UUID, occurredAt: Date) throws {
        guard UUID(uuidString: jobID) != nil else { throw GatewayError.invalidResponse }
        self.operationID = operationID
        self.jobID = jobID
        self.partition = partition
        self.eventID = eventID
        self.occurredAt = occurredAt
    }
}

/// Deduplicates bounded notification hints and resolves them only to tracked, partition-owned jobs.
public actor CompletionHintInbox {
    private var received: [UUID: Date] = [:]
    private let now: @Sendable () -> Date

    /// Creates an in-memory hint inbox; recovery remains functional when delivery is denied or missing.
    public init(now: @escaping @Sendable () -> Date = { Date() }) { self.now = now }

    /// Returns the operation to reconcile, or nil for a duplicate/out-of-order/unowned hint.
    public func receive(_ hint: CompletionNotificationHint, operations: [TrackedOperation]) -> UUID? {
        received = received.filter { now().timeIntervalSince($0.value) < 24 * 60 * 60 }
        //audit Assumption: APNs can duplicate and reorder payloads; hints never mutate terminal state and only trigger an authorized fetch.
        guard received[hint.eventID] == nil,
              let operation = operations.first(where: {
                  $0.id == hint.operationID && $0.partition == hint.partition && $0.backendJobID == hint.jobID
              }), hint.occurredAt >= operation.createdAt else { return nil }
        received[hint.eventID] = now()
        return operation.id
    }
}
