// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArcanosKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [
        .library(name: "ArcanosKit", targets: ["ArcanosKit"]),
        .executable(name: "ArcanosPreviewProof", targets: ["ArcanosPreviewProof"]),
        .executable(name: "ArcanosDeviceE2E", targets: ["ArcanosDeviceE2E"]),
        .executable(name: "ArcanosRecoveryProof", targets: ["ArcanosRecoveryProof"]),
        .executable(name: "ArcanosShippingRecoveryProof", targets: ["ArcanosShippingRecoveryProof"])
    ],
    targets: [
        .target(name: "ArcanosKit"),
        .testTarget(name: "ArcanosKitTests", dependencies: ["ArcanosKit"]),
        .executableTarget(name: "ArcanosPreviewProof", dependencies: ["ArcanosKit"]),
        .testTarget(name: "ArcanosPreviewProofTests", dependencies: ["ArcanosPreviewProof"]),
        .executableTarget(name: "ArcanosDeviceE2E", dependencies: ["ArcanosKit"]),
        .testTarget(name: "ArcanosDeviceE2ETests", dependencies: ["ArcanosDeviceE2E"]),
        .target(name: "ArcanosFixtureSupport", dependencies: ["ArcanosKit"]),
        .executableTarget(name: "ArcanosRecoveryProof", dependencies: ["ArcanosKit", "ArcanosFixtureSupport"]),
        .executableTarget(name: "ArcanosShippingRecoveryProof", dependencies: ["ArcanosKit", "ArcanosFixtureSupport"])
    ]
)
