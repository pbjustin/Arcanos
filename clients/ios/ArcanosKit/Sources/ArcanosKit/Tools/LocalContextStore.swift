import Foundation

/// A deliberately small local tool boundary. This store cannot invoke arbitrary tools or commands.
public protocol LocalContextProviding: Sendable {
    func capturedNote() async -> String?
}

public actor LocalContextStore: LocalContextProviding {
    private var note: String?
    public init() {}

    public func capture(_ text: String) throws {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 8_000 else { throw AIError.invalidInput }
        note = text
    }

    public func capturedNote() -> String? { note }
    public func clear() { note = nil }
}
