// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RpcExample",
    platforms: [.macOS(.v14)],
    dependencies: [.package(path: "../swift")],
    targets: [
        .executableTarget(
            name: "RpcExample",
            dependencies: [.product(name: "CalculatorSDK", package: "swift")]
        )
    ]
)
