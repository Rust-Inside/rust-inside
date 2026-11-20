# Rust Inside

[English](README.md) | [한국어](README.ko.md)

Rust Inside는 Rust 라이브러리를 플랫폼별 SDK로 배포합니다.

1. Rust 프로젝트에서 공개 API와 SDK 저장소를 지정합니다.
2. 코어에 릴리스 워크플로를 추가하고 버전 태그를 푸시합니다. GitHub Actions가 태그의 커밋에서 바인딩을 생성하고 SDK를 빌드해 배포합니다.
3. 앱이나 서버에 배포된 SDK를 설치하고 바인딩으로 Rust 코드를 호출합니다.

## 플랫폼별 설치와 사용법

샘플 `v0.1.0`의 `getMe()`를 호출하면 앱의 Rust 클라이언트가 계정 서버에 `GET /v1/me`를 보냅니다.

| 플랫폼 | 샘플 패키지 | 설치와 호출 예제 |
| --- | --- | --- |
| iOS | SwiftPM `SampleRustCoreSDK` | [iOS 가이드](https://github.com/Rust-Inside/sample-ios-sdk/blob/main/README.ko.md) |
| Android | Gradle AAR `sample-rust-core-android` | [Android 가이드](https://github.com/Rust-Inside/sample-android-sdk/blob/main/README.ko.md) |
| Flutter | pub `sample_rust_core_flutter` | [Flutter 가이드](https://github.com/Rust-Inside/sample-flutter-sdk/blob/main/README.ko.md) |
| 웹 | npm `sample-rust-core-web` | [웹 가이드](https://github.com/Rust-Inside/sample-web-sdk/blob/main/README.ko.md) |
| Kotlin/Spring | Gradle JAR `sample-rust-core-jvm` | [JVM 가이드](https://github.com/Rust-Inside/sample-server-sdk/blob/main/README.ko.md) |

샘플 워크플로는 수동으로 실행합니다. 내 프로젝트에서는 배포 템플릿으로 태그 릴리스를 설정할 수 있습니다. [샘플 Rust 프로젝트](https://github.com/Rust-Inside/sample-rust-core/blob/main/README.ko.md) · [릴리스 워크플로 템플릿](templates/release.yml)

<a id="코어-프로젝트-연결"></a>
<a id="첫-배포-설정"></a>

## 상세 사용법

Swift 호출 예제, 공개 API 설정, 첫 SDK 배포 절차를 확인하세요. [한국어 가이드](docs/usage.ko.md) · [English guide](docs/usage.md)

[Swift·Spring RPC 예제](docs/usage.ko.md#swift에서-rust-서버-함수-호출하기) · [로그인한 사용자로 신고하기](docs/usage.ko.md#로그인한-사용자로-신고하기)

## 라이선스

[MIT](LICENSE)
