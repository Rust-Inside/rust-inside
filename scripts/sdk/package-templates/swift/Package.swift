// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "RustInside",
    platforms: [.iOS(.v18), .macOS(.v14)],
    products: [.library(name: "RustInside", targets: ["RustInside"])],
    targets: [
        .binaryTarget(name: "RustInsideFFI", path: "RustInsideFFI.xcframework"),
        .target(name: "RustInside", dependencies: ["RustInsideFFI"])
    ]
)
