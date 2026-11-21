// swift-tools-version: 6.0

import PackageDescription

// Linux compile check with xtool (`make build`). The App Store build uses project.yml (XcodeGen) instead.
let package = Package(
    name: "Rezina",
    platforms: [
        .iOS(.v18), // Synchronization (Atomic) for the lock-free audio thread
        .macOS(.v15),
    ],
    products: [
        // An xtool project should contain exactly one library product, representing the main app.
        .library(name: "Rezina", targets: ["Rezina"]),
    ],
    targets: [
        .target(
            name: "Rezina",
            swiftSettings: [.swiftLanguageMode(.v5)]
        ),
    ]
)
