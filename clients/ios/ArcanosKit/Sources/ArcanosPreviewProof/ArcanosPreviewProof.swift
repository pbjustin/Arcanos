import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

@main
enum ArcanosPreviewProof {
    private struct FailureReport: Encodable {
        let status = "FAIL"
        let kind = "ios_gateway_client_https_proof"
        let code: String
        let executed: Bool
        let networkAttempted: Bool
        let requestsMade: Int
        let sourceCommit: String?
    }

    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        if arguments.first == "--recovery-phase" {
            await PreviewRecoveryProof.main(arguments: arguments)
            return
        }
        var activeRunner: ProofRunner?
        do {
            let configuration = try ProofConfiguration(arguments: arguments)
            try configuration.verifyGit()
            let runner = ProofRunner(configuration: configuration)
            activeRunner = runner
            let report = try await withThrowingTaskGroup(of: ProofReport.self) { group in
                group.addTask { try await runner.run() }
                group.addTask {
                    try await Task.sleep(for: .seconds(120))
                    throw ProofFailure("TOTAL_TIMEOUT")
                }
                defer { group.cancelAll() }
                guard let result = try await group.next() else { throw ProofFailure("PROOF_RESULT_MISSING") }
                return result
            }
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            FileHandle.standardOutput.write(try encoder.encode(report))
            FileHandle.standardOutput.write(Data("\n".utf8))
        } catch {
            let code = (error as? ProofFailure)?.code ?? "IOS_PREVIEW_PROOF_FAILED"
            let requests = await activeRunner?.transport.count() ?? 0
            let failure = FailureReport(code: code, executed: activeRunner?.configuration.execute ?? false,
                                        networkAttempted: requests > 0, requestsMade: requests,
                                        sourceCommit: activeRunner?.configuration.commit)
            if let data = try? JSONEncoder().encode(failure) { FileHandle.standardError.write(data) }
            FileHandle.standardError.write(Data("\n".utf8))
            exit(1)
        }
    }
}
