import ArcanosKit
import Foundation

enum PreviewFixture {
    static let version = "ios-gateway-client/v1"
    static let selector = "ios-gateway-v1"
    static let token = "test-ios-preview-only-v1"
    static let metadataPath = "/ios/gateway-contract"
    static let createPath = "/gpt-access/jobs/create"
    static let resultPath = "/gpt-access/jobs/result"
    static let listPath = "/gpt-access/capabilities/v1"
    static let detailPath = "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT"
    static let runPath = "/gpt-access/capabilities/v1/ARCANOS:LOCAL_AGENT/run"
    static let aiTask = "sealed-ios-gateway-ai-v1"
    static let aiAnswer = "Synthetic iOS Gateway answer."
    static let failedTask = "sealed-ios-gateway-failed-v1"
    static let unavailableTask = "sealed-ios-gateway-unavailable-v1"
    static let patch = "sealed-ios-preview-patch-v1"
    static let patchHash = String(repeating: "a", count: 64)
}

struct PreviewCredentials: GatewayCredentialProvider {
    let permittedOrigin: URL
    var token: String { PreviewFixture.token }
    func credential(for origin: URL) async throws -> GatewayCredential? {
        guard origin == permittedOrigin else { return nil }
        return GatewayCredential(token: token, origin: origin, expiresAt: Date().addingTimeInterval(180))
    }
}

/// Every response comes from the package's actual HTTPS transport. The wrapper records
/// finite fixture traffic and controls delivery timing; it never substitutes response data.
actor ObservedTransport: GatewayTransport {
    struct Exchange: Sendable {
        let request: GatewayRequest
        let response: GatewayResponse
    }
    private let actual = URLSessionGatewayTransport()
    private let origins: Set<URL>
    private let deadline = Date().addingTimeInterval(120)
    private var admitted = false
    private var requestsMade = 0
    private var responseBytes = 0
    private var exchanges: [Exchange] = []
    private var cancellationReceipt: (path: String, status: Int)?
    private var barrierJobID: String?
    private var heldResult: (GatewayResponse, CheckedContinuation<GatewayResponse, any Error>)?

    init(web: URL, worker: URL) { origins = [web, worker] }
    func admit() { admitted = true }
    func recorded() -> [Exchange] { exchanges }
    func count() -> Int { requestsMade }
    func bytes() -> Int { responseBytes }
    func cancelAfterReceipt(path: String, status: Int) { cancellationReceipt = (path, status) }
    func holdResultPair(jobID: String) { barrierJobID = jobID }

    func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        try Task.checkCancellation()
        guard var parts = URLComponents(url: request.url, resolvingAgainstBaseURL: false) else {
            throw ProofFailure("TRANSPORT_ORIGIN_INVALID")
        }
        let path = parts.path
        parts.path = ""
        try require(parts.url.map { origins.contains($0) } == true, "TRANSPORT_ORIGIN_DENIED")
        let readAllowed = request.method == "GET" && ["/readyz", PreviewFixture.metadataPath, PreviewFixture.listPath, PreviewFixture.detailPath].contains(path)
        let writeAllowed = request.method == "POST" && [PreviewFixture.createPath, PreviewFixture.resultPath, PreviewFixture.runPath].contains(path)
        try require(readAllowed || writeAllowed, "TRANSPORT_ROUTE_DENIED")
        try require(admitted || (request.method == "GET" && ["/readyz", PreviewFixture.metadataPath].contains(path)), "PREVIEW_IDENTITY_NOT_VERIFIED")
        try require(requestsMade < 40 && Date() < deadline, "TRANSPORT_BUDGET_EXHAUSTED")
        requestsMade += 1
        var headers = request.headers
        if path != "/readyz" { headers["x-native-preview-fixture"] = PreviewFixture.selector }
        let outgoing = GatewayRequest(url: request.url, method: request.method, headers: headers, body: request.body)
        let response: GatewayResponse
        do { response = try await actual.send(outgoing) }
        catch { releaseBarrier(); throw error }
        responseBytes += response.data.count
        try require(responseBytes <= 2_097_152 && Date() < deadline, "TRANSPORT_BUDGET_EXHAUSTED")
        exchanges.append(Exchange(request: outgoing, response: response))
        if let cancel = cancellationReceipt, cancel.path == path, cancel.status == response.statusCode {
            cancellationReceipt = nil
            withUnsafeCurrentTask { $0?.cancel() }
        }
        if path == PreviewFixture.resultPath, let barrierJobID, let body = request.body,
           try JSONDecoder().decode(JSONValue.self, from: body)["jobId"]?.stringValue == barrierJobID {
            if let held = heldResult {
                heldResult = nil
                self.barrierJobID = nil
                held.1.resume(returning: held.0)
            } else {
                return try await withTaskCancellationHandler {
                    try Task.checkCancellation()
                    return try await withCheckedThrowingContinuation { heldResult = (response, $0) }
                } onCancel: {
                    Task { await self.releaseBarrier() }
                }
            }
        }
        return response
    }

    private func releaseBarrier() {
        barrierJobID = nil
        let held = heldResult
        heldResult = nil
        held?.1.resume(throwing: CancellationError())
    }
}
