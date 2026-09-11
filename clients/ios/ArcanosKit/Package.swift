// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArcanosKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ArcanosKit", targets: ["ArcanosKit"]),
        .executable(name: "ArcanosPreviewProof", targets: ["ArcanosPreviewProof"])
    ],
    targets: [
        .target(name: "ArcanosKit"),
        .testTarget(name: "ArcanosKitTests", dependencies: ["ArcanosKit"]),
        .executableTarget(name: "ArcanosPreviewProof", dependencies: ["ArcanosKit"]),
        .testTarget(name: "ArcanosPreviewProofTests", dependencies: ["ArcanosPreviewProof"])
    ]
)
