import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct GatewayRequest: Sendable {
    public let url: URL
    public let method: String
    public let headers: [String: String]
    public let body: Data?

    public init(url: URL, method: String, headers: [String: String], body: Data? = nil) {
        self.url = url
        self.method = method
        self.headers = headers
        self.body = body
    }
}

public struct GatewayResponse: Sendable {
    public let statusCode: Int
    public let data: Data

    public init(statusCode: Int, data: Data) {
        self.statusCode = statusCode
        self.data = data
    }
}

public protocol GatewayTransport: Sendable {
    func send(_ request: GatewayRequest) async throws -> GatewayResponse
}

/// Credentials cannot follow redirects, including redirects to another path on the same host.
private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

public final class URLSessionGatewayTransport: GatewayTransport, Sendable {
    private let session: URLSession
    private let delegate: NoRedirectDelegate

    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 20
        let delegate = NoRedirectDelegate()
        self.delegate = delegate
        self.session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    public func send(_ request: GatewayRequest) async throws -> GatewayResponse {
        guard request.url.scheme?.lowercased() == "https" else { throw GatewayError.invalidConfiguration }
        var urlRequest = URLRequest(url: request.url)
        urlRequest.httpMethod = request.method
        urlRequest.httpBody = request.body
        urlRequest.allHTTPHeaderFields = request.headers
        let (data, response) = try await session.data(for: urlRequest)
        guard let http = response as? HTTPURLResponse, http.url == request.url,
              data.count <= 2_097_152 else { throw GatewayError.invalidResponse }
        guard !(300...399).contains(http.statusCode) else { throw GatewayError.redirectRejected }
        return GatewayResponse(statusCode: http.statusCode, data: data)
    }
}
