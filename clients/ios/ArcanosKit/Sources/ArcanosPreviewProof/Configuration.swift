import Foundation

struct ProofFailure: Error, Sendable {
    let code: String
    init(_ code: String) { self.code = code }
}

func require(_ condition: Bool, _ code: String) throws {
    if !condition { throw ProofFailure(code) }
}

struct ProofConfiguration: Sendable {
    let prNumber: Int
    let commit: String
    let repositoryRoot: URL
    let web: URL
    let worker: URL
    let execute: Bool

    init(arguments: [String]) throws {
        let valueKeys: Set<String> = ["--pr-number", "--commit-sha", "--repository-root", "--web-base-url", "--worker-base-url"]
        let flagKeys: Set<String> = ["--execute", "--allow-network"]
        var values: [String: String] = [:]
        var flags: Set<String> = []
        var index = 0
        while index < arguments.count {
            let key = arguments[index]
            if flagKeys.contains(key) {
                try require(flags.insert(key).inserted, "DUPLICATE_ARGUMENT")
            } else {
                try require(valueKeys.contains(key), "UNKNOWN_ARGUMENT")
                try require(values[key] == nil && index + 1 < arguments.count, "MISSING_OR_DUPLICATE_ARGUMENT")
                index += 1
                values[key] = arguments[index]
            }
            index += 1
        }
        try require(values.count == valueKeys.count, "REQUIRED_ARGUMENT_MISSING")
        try require(flags.isEmpty || flags == flagKeys, "NETWORK_OPT_IN_INCOMPLETE")
        guard let pr = Int(values["--pr-number"] ?? ""), pr > 0,
              String(pr) == values["--pr-number"],
              let commit = values["--commit-sha"], commit.range(of: "^[0-9a-f]{40}$", options: .regularExpression) != nil,
              let root = values["--repository-root"], root.hasPrefix("/") else {
            throw ProofFailure("INVALID_IDENTITY_ARGUMENT")
        }
        prNumber = pr
        self.commit = commit
        repositoryRoot = URL(fileURLWithPath: root, isDirectory: true).standardizedFileURL
        web = try Self.origin(values["--web-base-url"]!, pr: pr)
        worker = try Self.origin(values["--worker-base-url"]!, pr: pr)
        try require(web != worker, "ORIGINS_MUST_DIFFER")
        execute = flags == flagKeys
    }

    private static func origin(_ value: String, pr: Int) throws -> URL {
        guard var parts = URLComponents(string: value), parts.scheme == "https",
              let host = parts.host, host.hasSuffix(".up.railway.app"),
              host.range(of: "(?:^|[.-])pr-(?:[0-9a-f]{6}-)?\(pr)(?:[.-]|$)", options: [.regularExpression, .caseInsensitive]) != nil,
              host.range(of: "(?:^|[.-])production(?:[.-]|$)", options: [.regularExpression, .caseInsensitive]) == nil,
              parts.user == nil, parts.password == nil, parts.port == nil,
              parts.query == nil, parts.fragment == nil, ["", "/"].contains(parts.path) else {
            throw ProofFailure("INVALID_PREVIEW_ORIGIN")
        }
        parts.path = ""
        guard let origin = parts.url else { throw ProofFailure("INVALID_PREVIEW_ORIGIN") }
        return origin
    }

    func verifyGit() throws {
        let actualRoot = try git(["rev-parse", "--show-toplevel"]).trimmingCharacters(in: .whitespacesAndNewlines)
        try require(URL(fileURLWithPath: actualRoot).standardizedFileURL == repositoryRoot, "GIT_ROOT_MISMATCH")
        try require(try git(["rev-parse", "HEAD"]).trimmingCharacters(in: .whitespacesAndNewlines) == commit, "GIT_HEAD_MISMATCH")
        let origin = try git(["remote", "get-url", "origin"]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        try require(["https://github.com/pbjustin/arcanos", "https://github.com/pbjustin/arcanos.git", "git@github.com:pbjustin/arcanos.git", "git@github.com:pbjustin/arcanos", "ssh://git@github.com/pbjustin/arcanos.git"].contains(origin), "GIT_ORIGIN_MISMATCH")
        try require(try git(["status", "--porcelain", "--untracked-files=all"]).isEmpty, "GIT_WORKTREE_DIRTY")
    }

    private func git(_ arguments: [String]) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.currentDirectoryURL = repositoryRoot
        process.arguments = ["-c", "core.fsmonitor=false"] + arguments
        process.environment = ["GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LANG": "C", "LC_ALL": "C", "PATH": "/usr/bin:/bin"]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        try process.run()
        let deadline = Date().addingTimeInterval(10)
        while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
        guard !process.isRunning else { process.terminate(); throw ProofFailure("GIT_TIMEOUT") }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        try require(process.terminationStatus == 0 && data.count <= 65_536, "GIT_UNAVAILABLE")
        guard let text = String(data: data, encoding: .utf8) else { throw ProofFailure("GIT_OUTPUT_INVALID") }
        return text
    }
}
