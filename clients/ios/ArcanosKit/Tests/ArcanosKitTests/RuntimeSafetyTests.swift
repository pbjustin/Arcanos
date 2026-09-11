import Foundation
import Testing
@testable import ArcanosKit

private struct RuntimeSafetyFile: Sendable {
    let directory: URL
    let temporaryRoot: URL
    var persistence: FileOperationPersistence {
        FileOperationPersistence(fileURL: directory.appendingPathComponent("operations.json"))
    }

    init() throws {
        temporaryRoot = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
        directory = temporaryRoot.appendingPathComponent("ArcanosRuntimeSafety-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
    }

    func remove() throws {
        let resolved = directory.resolvingSymlinksInPath()
        guard resolved.deletingLastPathComponent() == temporaryRoot,
              resolved.lastPathComponent.hasPrefix("ArcanosRuntimeSafety-") else {
            throw CocoaError(.fileWriteInvalidFileName)
        }
        try FileManager.default.removeItem(at: resolved)
    }
}

private final class RuntimeCredentialItems: CredentialItemStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String: Data] = [:]
    private var unreadable = false
    private var nextReplacement: (account: String, data: Data)?

    func read(account: String) throws -> Data? {
        try lock.withLock {
            guard !unreadable else { throw CredentialStoreError.lockedOrUnavailable }
            let result = items[account]
            if let replacement = nextReplacement, replacement.account == account {
                items[account] = replacement.data
                nextReplacement = nil
            }
            return result
        }
    }
    func replace(account: String, data: Data) { lock.withLock { items[account] = data } }
    func remove(account: String) { lock.withLock { _ = items.removeValue(forKey: account) } }
    func snapshot() -> [String: Data] { lock.withLock { items } }
    func lockReads(_ value: Bool) { lock.withLock { unreadable = value } }
    func rotateAfterNextRead(account: String, data: Data) {
        lock.withLock { nextReplacement = (account, data) }
    }
}

@Suite("Shipping recovery storage coordination")
struct RuntimeSafetyTests {
    private let origin = URL(string: "https://runtime-safety.example.invalid")!
    private let deviceID = "11111111-1111-4111-8111-111111111111"
    private let otherDeviceID = "22222222-2222-4222-8222-222222222222"
    private let jobID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    private let instant = Date(timeIntervalSince1970: 1_800_000_000)

    private func operation(_ key: String, partition: OperationPartition) throws -> TrackedOperation {
        try TrackedOperation(partition: partition, kind: .remoteAI, displaySummary: "Remote ARCANOS request",
            createdAt: instant, idempotencyKey: key)
    }

    private func issuedSession(device: String, marker: Character = "A") -> DeviceCredentialResponse {
        let format = ISO8601DateFormatter()
        // Public synthetic fixture tokens; these never authenticate outside the injected store.
        return DeviceCredentialResponse(ok: true, deviceId: device,
            credential: "agd1." + String(repeating: String(marker), count: 43), tokenType: "Bearer",
            audience: "gpt-access-device-v1", origin: origin.absoluteString,
            issuedAt: format.string(from: instant), expiresAt: format.string(from: instant.addingTimeInterval(3600)),
            renewalExpiresAt: format.string(from: instant.addingTimeInterval(30 * 24 * 3600)),
            scopes: ["jobs.create", "jobs.result"], capabilityActions: [], gptIds: ["arcanos-core"])
    }

    @Test("an already opened app tracker observes a later intent receipt")
    func preloadedReaderSeesNewReceipt() async throws {
        let file = try RuntimeSafetyFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceID)
        let app = OperationTracker(persistence: file.persistence, now: { instant })
        let intent = OperationTracker(persistence: file.persistence, now: { instant })
        #expect(try await app.operations(for: partition).isEmpty)
        let submitted = try operation("intent-submission", partition: partition)
        try await intent.prepare(submitted)
        try await intent.accept(submitted.id, jobID: jobID, backendStatus: "queued")
        let restored = try #require(try await app.operations(for: partition).first)
        #expect(restored.id == submitted.id)
        #expect(restored.backendJobID == jobID)
        #expect(restored.idempotencyKey == submitted.idempotencyKey)
    }

    @Test("separate writers preserve distinct submissions after each has loaded the file")
    func separateWritersDoNotLoseRecords() async throws {
        let file = try RuntimeSafetyFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceID)
        let app = OperationTracker(persistence: file.persistence, now: { instant })
        let intent = OperationTracker(persistence: file.persistence, now: { instant })
        #expect(try await app.operations(for: partition).isEmpty)
        #expect(try await intent.operations(for: partition).isEmpty)
        let first = try operation("app-request", partition: partition)
        let second = try operation("intent-request", partition: partition)
        try await app.prepare(first)
        try await intent.prepare(second)
        let expected: Set<UUID> = [first.id, second.id]
        #expect(Set(try await app.operations(for: partition).map(\.id)) == expected)
        #expect(Set(try await intent.operations(for: partition).map(\.id)) == expected)
    }

    @Test("an older observer cannot regress another tracker's terminal observation")
    func staleObserverPreservesTerminalState() async throws {
        let file = try RuntimeSafetyFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceID)
        let app = OperationTracker(persistence: file.persistence, now: { instant })
        let submitted = try operation("terminal-observation", partition: partition)
        try await app.prepare(submitted)
        try await app.accept(submitted.id, jobID: jobID, backendStatus: "queued")
        let intent = OperationTracker(persistence: file.persistence, now: { instant })
        #expect(try await intent.operations(for: partition).first?.localState == .accepted)
        try await app.observe(submitted.id, jobID: jobID, backendStatus: "completed", terminal: true)
        try await intent.observe(submitted.id, jobID: jobID, backendStatus: "pending", terminal: false)
        let restored = try #require(try await app.operations(for: partition).first)
        #expect(restored.backendStatus == "completed")
        #expect(restored.localState == .terminal)
        #expect(restored.backendJobID == jobID)
    }

    @Test("a stale writer cannot resurrect a removed authentication partition")
    func staleWriterPreservesPartitionRemoval() async throws {
        let file = try RuntimeSafetyFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceID)
        let other = try OperationPartition(origin: origin, deviceID: otherDeviceID)
        let app = OperationTracker(persistence: file.persistence, now: { instant })
        let old = try operation("old-device", partition: partition)
        try await app.prepare(old)
        let intent = OperationTracker(persistence: file.persistence, now: { instant })
        #expect(try await intent.operations(for: partition).count == 1)
        try await app.removeAll(for: partition)
        let new = try operation("new-device", partition: other)
        try await intent.prepare(new)
        #expect(try await intent.operations(for: partition).isEmpty)
        #expect(try await app.operations(for: other) == [new])
        await #expect(throws: OperationTrackingError.notFound) {
            try await intent.accept(old.id, jobID: jobID, backendStatus: "queued")
        }
    }

    @Test("separate tracker submissions arbitrate one idempotency key")
    func concurrentPrepareHasOneWinner() async throws {
        let file = try RuntimeSafetyFile()
        defer { try? file.remove() }
        let partition = try OperationPartition(origin: origin, deviceID: deviceID)
        let trackers = (0..<12).map { _ in OperationTracker(persistence: file.persistence, now: { instant }) }
        for tracker in trackers { #expect(try await tracker.operations(for: partition).isEmpty) }
        let candidates = try trackers.map { _ in try operation("same-semantic-request", partition: partition) }
        let successes = await withTaskGroup(of: Bool.self) { group in
            for (tracker, candidate) in zip(trackers, candidates) {
                group.addTask {
                    do {
                        try await tracker.prepare(candidate)
                        return true
                    } catch GatewayError.invalidRequest {
                        return false
                    } catch {
                        Issue.record("Unexpected persistence failure: \(type(of: error))")
                        return false
                    }
                }
            }
            var count = 0
            for await succeeded in group { if succeeded { count += 1 } }
            return count
        }
        #expect(successes == 1)
        let fresh = OperationTracker(persistence: file.persistence, now: { instant })
        let records = try await fresh.operations(for: partition)
        #expect(records.count == 1)
        #expect(records.first?.idempotencyKey == "same-semantic-request")
    }

    @Test("temporary secure-storage denial never erases a session or recreates identity")
    func temporarySecureStorageDenialPreservesPairing() async throws {
        let items = RuntimeCredentialItems()
        let store = KeychainCredentialStore(storage: items, now: { instant })
        let session = issuedSession(device: deviceID)
        try await store.storePairedSession(session, for: origin)
        let identity = try await store.localIdentity(for: origin)
        let before = items.snapshot()
        items.lockReads(true)
        await #expect(throws: CredentialStoreError.self) { try await store.authenticatedContext(for: origin) }
        await #expect(throws: CredentialStoreError.self) { try await store.localIdentity(for: origin) }
        #expect(items.snapshot() == before)
        items.lockReads(false)
        let context = try #require(try await store.authenticatedContext(for: origin))
        #expect(context.deviceID == deviceID)
        #expect(context.credential.token == session.credential)
        #expect(try await store.localIdentity(for: origin) == identity)
        #expect(try await store.state(for: origin) == .paired)
    }

    @Test("a concurrent Keychain replacement cannot mix old credentials with new device identity")
    func authenticatedContextUsesOneSecureSnapshot() async throws {
        let items = RuntimeCredentialItems()
        let store = KeychainCredentialStore(storage: items, now: { instant })
        let original = issuedSession(device: deviceID)
        let replacement = issuedSession(device: otherDeviceID, marker: "B")
        let replacementItems = RuntimeCredentialItems()
        let replacementStore = KeychainCredentialStore(storage: replacementItems, now: { instant })
        try await replacementStore.storePairedSession(replacement, for: origin)
        let account = "session:\(origin.absoluteString)"
        let replacementData = try #require(replacementItems.snapshot()[account])
        try await store.storePairedSession(original, for: origin)
        items.rotateAfterNextRead(account: account, data: replacementData)
        let captured = try #require(try await store.authenticatedContext(for: origin))
        #expect(captured.deviceID == deviceID)
        #expect(captured.credential.token == original.credential)
        let current = try #require(try await store.authenticatedContext(for: origin))
        #expect(current.deviceID == otherDeviceID)
        #expect(current.credential.token == replacement.credential)
        #expect(!captured.description.contains(original.credential))
    }

    @Test("expired and revoked sessions do not yield authenticated recovery contexts")
    func expiredAndRevokedContextsAreUnavailable() async throws {
        let items = RuntimeCredentialItems()
        let session = issuedSession(device: deviceID)
        let store = KeychainCredentialStore(storage: items, now: { instant })
        try await store.storePairedSession(session, for: origin)
        let expired = KeychainCredentialStore(storage: items, now: { instant.addingTimeInterval(3601) })
        await #expect(throws: GatewayError.credentialExpired) { try await expired.authenticatedContext(for: origin) }
        await store.rejectedCredential(session.credential, for: origin, error: .credentialRevoked)
        await #expect(throws: GatewayError.credentialRevoked) { try await store.authenticatedContext(for: origin) }
        #expect(try await store.pairedDeviceID(for: origin) == deviceID)
        #expect(try await store.authenticatedContext(for: URL(string: "https://another.example.invalid")!)?.deviceID == nil)
    }
}
