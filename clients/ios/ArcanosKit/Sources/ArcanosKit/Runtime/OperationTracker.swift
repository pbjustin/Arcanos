import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

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
    /// Optional finite action identifier; older recovery records remain readable.
    public let capabilityAction: String?
    public var backendJobID: String?
    public var backendStatus: String?
    public var localState: LocalOperationState
    public var previewReference: String?

    /// Creates a pre-network record so a crash cannot erase submission uncertainty.
    public init(id: UUID = UUID(), partition: OperationPartition, kind: TrackedOperationKind,
                displaySummary: String, createdAt: Date, idempotencyKey: String,
                capabilityAction: String? = nil) throws {
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
        self.capabilityAction = capabilityAction
        self.localState = .prepared
    }
}

/// Injected persistence boundary used by the tracker and deterministic tests.
public protocol OperationPersistence: Sendable {
    func load() throws -> Data?
    func replace(with data: Data) throws
    func withExclusiveAccess<T>(isolation: isolated (any Actor)?, _ body: () throws -> T) throws -> T
}

public extension OperationPersistence {
    /// Single-owner fixtures may use the default. Shared persistence must serialize transactions.
    func withExclusiveAccess<T>(isolation: isolated (any Actor)? = #isolation, _ body: () throws -> T) throws -> T { try body() }
}

/// Atomic file-backed storage for non-secret operation metadata.
public struct FileOperationPersistence: OperationPersistence {
    public let fileURL: URL

    /// Uses an application-support file supplied by the host; parent directories are created lazily.
    public init(fileURL: URL) { self.fileURL = fileURL }

    /// Lock the stable sidecar, not the atomically replaced data inode. The OS releases
    /// this lock on process death; no termination callback or persisted lease is needed.
    public func withExclusiveAccess<T>(isolation: isolated (any Actor)? = #isolation, _ body: () throws -> T) throws -> T {
        #if canImport(Darwin) || canImport(Glibc)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        let descriptor = open(fileURL.appendingPathExtension("lock").path, O_CREAT | O_RDWR | O_CLOEXEC, S_IRUSR | S_IWUSR)
        guard descriptor >= 0 else { throw OperationTrackingError.storageUnavailable }
        defer { _ = close(descriptor) }
        // Transactions contain only bounded local file work, never network awaits.
        // Bound contention to one second even if a peer has been suspended mid-write.
        var acquired = false
        for _ in 0..<100 {
            if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { acquired = true; break }
            guard errno == EWOULDBLOCK || errno == EAGAIN else { throw OperationTrackingError.storageUnavailable }
            usleep(10_000)
        }
        guard acquired else { throw OperationTrackingError.storageUnavailable }
        defer { _ = flock(descriptor, LOCK_UN) }
        return try body()
        #else
        throw OperationTrackingError.storageUnavailable
        #endif
    }

    public func load() throws -> Data? {
        do { return try Data(contentsOf: fileURL, options: .mappedIfSafe) }
        catch let error as CocoaError where error.code == .fileReadNoSuchFile { return nil }
    }

    public func replace(with data: Data) throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try data.write(to: fileURL, options: [.atomic, .completeFileProtection])
    }
}

/// Serializes recovery-index changes and enforces authenticated partition isolation.
public actor OperationTracker {
    private static let acceptanceStatuses: Set<String> = ["pending", "queued", "running", "completed", "failed", "cancelled", "expired"]
    private static let observationStatuses: Set<String> = ["pending", "completed", "failed", "expired", "not_found"]
    private static let terminalStatuses: Set<String> = ["completed", "failed", "cancelled", "expired", "not_found"]
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
        try Self.validate(operation)
        guard operation.localState == .prepared else { throw GatewayError.invalidRequest }
        return try transaction {
            var values = try current()
            //audit Assumption: an idempotency key identifies one semantic operation in one security partition; reject collisions rather than guessing.
            guard !values.contains(where: {
                $0.id == operation.id || ($0.partition == operation.partition && $0.idempotencyKey == operation.idempotencyKey)
            }) else {
                throw GatewayError.invalidRequest
            }
            values.append(operation)
            try commit(values)
            return operation.id
        }
    }

    /// Records a confirmed backend acceptance without treating acceptance as completion.
    public func accept(_ id: UUID, jobID: String, backendStatus: String) throws {
        guard UUID(uuidString: jobID) != nil, Self.acceptanceStatuses.contains(backendStatus) else {
            throw GatewayError.invalidResponse
        }
        try update(id) { record in
            guard record.backendJobID == nil || record.backendJobID == jobID else { throw GatewayError.invalidResponse }
            // A retried receipt cannot replace an accepted handle or overwrite a later result observation.
            guard ![.observing, .terminal, .dismissed].contains(record.localState) else { return }
            record.backendJobID = jobID
            record.backendStatus = backendStatus
            record.localState = Self.terminalStatuses.contains(backendStatus) ? .terminal : .accepted
        }
    }

    /// Marks a transport outcome ambiguous; this never authorizes automatic replay.
    public func markSubmissionUncertain(_ id: UUID) throws {
        try update(id) { record in
            guard record.backendJobID == nil, record.localState != .dismissed else { return }
            record.localState = .submissionUncertain
        }
    }

    /// Only a pending approval cancelled or expired before its retry may call this.
    /// Accepted or uncertain work must retain its existing recovery evidence.
    func dismissUnsubmittedApproval(_ id: UUID) throws {
        try update(id) { record in
            guard record.backendJobID == nil, record.localState == .prepared else {
                throw GatewayError.invalidRequest
            }
            record.localState = .dismissed
        }
    }

    /// Applies an authorized status read to a known accepted job.
    public func observe(_ id: UUID, jobID: String, backendStatus: String, terminal: Bool) throws {
        guard Self.observationStatuses.contains(backendStatus), terminal == Self.terminalStatuses.contains(backendStatus) else {
            throw GatewayError.invalidResponse
        }
        try update(id) { record in
            //audit Assumption: response identity must equal the accepted handle; mismatch is untrusted transport data and fails closed.
            guard record.backendJobID == jobID else { throw GatewayError.invalidResponse }
            // Concurrent reads may arrive out of order; completed recovery evidence must not become pending again.
            guard ![.terminal, .dismissed].contains(record.localState) else { return }
            record.backendStatus = backendStatus
            record.localState = terminal ? .terminal : .observing
        }
    }

    /// Returns only records belonging to the current authenticated device/origin partition.
    public func operations(for partition: OperationPartition) throws -> [TrackedOperation] {
        try transaction {
            try prune()
            return try current().filter { $0.partition == partition }.sorted { $0.updatedAt > $1.updatedAt }
        }
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
        try transaction { try commit(try current().filter { $0.partition != partition }) }
    }

    private func update(_ id: UUID, mutation: (inout TrackedOperation) throws -> Void) throws {
        try transaction {
            var values = try current()
            guard let index = values.firstIndex(where: { $0.id == id }) else { throw OperationTrackingError.notFound }
            let previous = values[index]
            try mutation(&values[index])
            guard values[index] != previous else { return }
            values[index].updatedAt = now()
            try commit(values)
        }
    }

    private func transaction<T>(_ body: () throws -> T) throws -> T {
        // Invalidate before acquiring; all reads occur inside the synchronous locked
        // body. A previous snapshot must never survive into a new transaction.
        records = nil
        return try persistence.withExclusiveAccess(isolation: self, body)
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
            var ids: Set<UUID> = []
            var keys: [OperationPartition: Set<String>] = [:]
            for operation in decoded {
                try Self.validate(operation)
                guard ids.insert(operation.id).inserted,
                      keys[operation.partition, default: []].insert(operation.idempotencyKey).inserted else {
                    throw OperationTrackingError.corruptStore
                }
            }
            records = decoded
            return decoded
        } catch {
            //audit Assumption: corrupt local cache has no authority; surface failure rather than silently discarding recovery evidence.
            throw OperationTrackingError.corruptStore
        }
    }

    private static func validate(_ operation: TrackedOperation) throws {
        if let action = operation.capabilityAction {
            guard ["git.status", "tests.run", "patch.preview", "patch.apply"].contains(action),
                  operation.kind != .remoteAI else { throw GatewayError.invalidRequest }
        }
        guard let origin = URL(string: operation.partition.origin),
              let partition = try? OperationPartition(origin: origin, deviceID: operation.partition.deviceID),
              partition == operation.partition,
              operation.createdAt.timeIntervalSinceReferenceDate.isFinite,
              operation.updatedAt.timeIntervalSinceReferenceDate.isFinite else { throw GatewayError.invalidRequest }
        let prepared = try TrackedOperation(id: operation.id, partition: partition, kind: operation.kind,
            displaySummary: operation.displaySummary, createdAt: operation.createdAt, idempotencyKey: operation.idempotencyKey)
        guard prepared.displaySummary == operation.displaySummary else { throw GatewayError.invalidRequest }
        if let jobID = operation.backendJobID {
            guard UUID(uuidString: jobID) != nil, let status = operation.backendStatus else { throw GatewayError.invalidRequest }
            switch operation.localState {
            case .accepted:
                guard Self.acceptanceStatuses.contains(status), !Self.terminalStatuses.contains(status) else { throw GatewayError.invalidRequest }
            case .observing:
                guard status == "pending" else { throw GatewayError.invalidRequest }
            case .terminal:
                guard Self.terminalStatuses.contains(status) else { throw GatewayError.invalidRequest }
            case .dismissed:
                guard Self.acceptanceStatuses.contains(status) || Self.observationStatuses.contains(status) else { throw GatewayError.invalidRequest }
            case .prepared, .submissionUncertain:
                throw GatewayError.invalidRequest
            }
        } else {
            guard operation.backendStatus == nil,
                  [.prepared, .submissionUncertain, .dismissed].contains(operation.localState) else { throw GatewayError.invalidRequest }
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
    case notFound, corruptStore, ambiguousReference, storageUnavailable
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

    /// Returns the operation to reconcile, or nil for a duplicate/pre-operation/unowned hint.
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
