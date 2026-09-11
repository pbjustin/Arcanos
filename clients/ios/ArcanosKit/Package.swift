// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArcanosKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ArcanosKit", targets: ["ArcanosKit"]),
        .executable(name: "ArcanosPreviewProof", targets: ["ArcanosPreviewProof"]),
        .executable(name: "ArcanosDeviceE2E", targets: ["ArcanosDeviceE2E"]),
        .executable(name: "ArcanosRecoveryProof", targets: ["ArcanosRecoveryProof"])
    ],
    targets: [
        .target(name: "ArcanosKit"),
        .testTarget(name: "ArcanosKitTests", dependencies: ["ArcanosKit"]),
        .executableTarget(name: "ArcanosPreviewProof", dependencies: ["ArcanosKit"]),
        .testTarget(name: "ArcanosPreviewProofTests", dependencies: ["ArcanosPreviewProof"]),
        .executableTarget(name: "ArcanosDeviceE2E", dependencies: ["ArcanosKit"]),
        .testTarget(name: "ArcanosDeviceE2ETests", dependencies: ["ArcanosDeviceE2E"]),
        .executableTarget(name: "ArcanosRecoveryProof", dependencies: ["ArcanosKit"])
    ]
)
