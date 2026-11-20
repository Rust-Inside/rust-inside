# Rust Inside

[English](README.md) | [한국어](README.ko.md)

Rust Inside is cross-platform SDK build and release tooling for Rust libraries.

1. Choose the public API and destination repositories in your Rust project.
2. Add the release workflow and push a version tag. GitHub Actions generates bindings and publishes the packages built from that commit.
3. Install the version in your app or server and call Rust through the generated bindings.

<a id="플랫폼별-설치와-사용법"></a>

## Install a platform SDK

Install `v0.2.0` to try `getMe()`. The SDK runs the Rust client, which sends `GET /v1/me` to your account server.

| Platform | Sample package | Install and use |
| --- | --- | --- |
| iOS | SwiftPM `SampleRustCoreSDK` | [iOS guide](https://github.com/Rust-Inside/sample-ios-sdk#readme) |
| Android | Gradle AAR `sample-rust-core-android` | [Android guide](https://github.com/Rust-Inside/sample-android-sdk#readme) |
| Flutter | pub `sample_rust_core_flutter` | [Flutter guide](https://github.com/Rust-Inside/sample-flutter-sdk#readme) |
| Web | npm `sample-rust-core-web` | [Web guide](https://github.com/Rust-Inside/sample-web-sdk#readme) |
| Kotlin/Spring | Gradle JAR `sample-rust-core-jvm` | [JVM guide](https://github.com/Rust-Inside/sample-server-sdk#readme) |

Run the sample workflow manually. In your own repository, the release template publishes on version tags. [Sample Rust project](https://github.com/Rust-Inside/sample-rust-core) · [Release workflow template](templates/release.yml)

<a id="connect-your-rust-project"></a>
<a id="set-up-your-first-multiplatform-release"></a>

## Usage guide

Call the sample from Swift or set up your own Rust API and release pipeline. [English guide](docs/usage.md) · [한국어 가이드](docs/usage.ko.md)

## License

[MIT](LICENSE)
