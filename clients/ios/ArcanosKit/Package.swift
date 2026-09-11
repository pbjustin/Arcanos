// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ArcanosKit",
    platforms: [.iOS(.v18), .macOS(.v15)],
    products: [.library(name: "ArcanosKit", targets: ["ArcanosKit"])],
    targets: [
        .target(name: "ArcanosKit"),
        .testTarget(name: "ArcanosKitTests", dependencies: ["ArcanosKit"])
    ]
)
