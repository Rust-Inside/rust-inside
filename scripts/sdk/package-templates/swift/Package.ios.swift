// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "@SWIFT_MODULE@",
    platforms: [.iOS(.v18)],
    products: [.library(name: "@SWIFT_MODULE@", targets: ["@SWIFT_MODULE@"])],
    targets: [
        .binaryTarget(name: "@FFI_MODULE@", path: "@FFI_MODULE@.xcframework"),
        .target(
            name: "@SWIFT_MODULE@",
            dependencies: ["@FFI_MODULE@"],
            linkerSettings: [.linkedLibrary("iconv")]
        )
    ]
)
