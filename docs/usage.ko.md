# Rust Inside 사용법

[English](usage.md) | [한국어](usage.ko.md) | [저장소 개요](../README.ko.md)

앱이나 서버에 플랫폼별 SDK를 설치하면 Rust Inside가 생성한 바인딩을 통해 Rust 코드를 호출할 수 있습니다.

## 플랫폼별 설치와 사용법

샘플 `v0.1.0`을 설치할 플랫폼을 고르세요.

| 플랫폼 | 앱이나 서버에 추가할 패키지 | 지원 환경 | 설치와 호출 예제 |
| --- | --- | --- | --- |
| iOS | SwiftPM의 `SampleRustCoreSDK` | iOS 18 이상, arm64 기기·시뮬레이터, Swift tools 6.0 | [Swift 가이드](https://github.com/Rust-Inside/sample-ios-sdk/blob/main/README.ko.md) |
| Android | Gradle의 `sample-rust-core-android` AAR | API 23 이상, arm64-v8a·x86_64 | [Android 가이드](https://github.com/Rust-Inside/sample-android-sdk/blob/main/README.ko.md) |
| Flutter | pub의 `sample_rust_core_flutter` Git 패키지 | iOS·Android, Flutter 3.38 이상, Dart 3.10 이상 4 미만 | [Dart 가이드](https://github.com/Rust-Inside/sample-flutter-sdk/blob/main/README.ko.md) |
| 웹 | npm의 `sample-rust-core-web` | ES 모듈과 WebAssembly를 지원하는 브라우저 | [웹 가이드](https://github.com/Rust-Inside/sample-web-sdk/blob/main/README.ko.md) |
| Kotlin/Spring | Gradle의 `sample-rust-core-jvm` JAR | JVM 17 이상, Linux glibc(x86-64·ARM64) 또는 Apple Silicon macOS | [JVM 서버 가이드](https://github.com/Rust-Inside/sample-server-sdk/blob/main/README.ko.md) |

### Swift에서 프로필 조회하기

Xcode에서 **File → Add Package Dependencies**를 열고 `https://github.com/Rust-Inside/sample-ios-sdk.git`를 입력하세요. **Exact Version** `0.1.0`의 `SampleRustCoreSDK`를 앱 타깃에 추가하면 SwiftPM이 빌드된 XCFramework를 받습니다. [iOS v0.1.0 릴리스](https://github.com/Rust-Inside/sample-ios-sdk/releases/tag/v0.1.0)

```swift
import SampleRustCoreSDK

func displayName(apiOrigin: String, accessToken: String) async throws -> String {
    let account = AccountClient(baseUrl: apiOrigin, authorization: "Bearer \(accessToken)")
    let profile = try await account.getMe()
    return profile.displayName
}
```

계정 서버 주소와 사용자 액세스 토큰을 넘기세요. Swift의 `getMe()`는 앱에 포함된 Rust의 `AccountClient::get_me`를 실행합니다. Rust 클라이언트가 인증 헤더와 함께 `GET /v1/me`를 보내면, 서버는 요청을 인증하고 `id`, `handle`, `displayName`이 담긴 JSON을 반환합니다. 클라이언트는 이 JSON을 프로필 객체로 읽습니다. [샘플 코어](https://github.com/Rust-Inside/sample-rust-core/blob/main/README.ko.md) · [v0.1.0 Rust 구현](https://github.com/Rust-Inside/sample-rust-core/blob/v0.1.0/src/api.rs) · [Spring 컨트롤러 예제](https://github.com/Rust-Inside/sample-server-sdk/blob/main/README.ko.md#로그인한-사용자의-프로필-응답)

`sample-rust-core`를 포크해 GitHub Actions를 켜세요. **Actions → Release sample SDKs → Run workflow**에서 `release_tag`를 비워 두면 빌드만 시험합니다. [샘플 워크플로](https://github.com/Rust-Inside/sample-rust-core/blob/main/.github/workflows/release.yml)

## Swift에서 Rust 서버 함수 호출하기

계산기 예제는 서버에서 실행할 함수를 Rust에 한 번 정의합니다. RPC 생성기가 함수 시그니처를 읽어 Swift 호출 메서드와 Spring 라우트를 만듭니다. [Rust 소스](../examples/swift-spring-rpc/src/api.rs) · [설정 파일](../examples/swift-spring-rpc/rust-inside.json)

```rust
#[rust_inside::server]
pub fn add(a: i32, b: i32) -> i64 {
    i64::from(a) + i64::from(b)
}
```

Swift에서는 서버 주소로 클라이언트를 한 번 생성합니다. 생성된 메서드는 `Int32` 두 개를 받아 `Int64`를 반환합니다.

```swift
import CalculatorSDK
import Foundation

let calculator = RpcClient(baseURL: serverURL)
let result = try await calculator.add(2, 3) // 5
```

1. Swift 클라이언트가 `{"a":2,"b":3}`을 담아 `POST /rpc/add`를 보냅니다.
2. 생성된 Spring 라우트가 인자를 읽고 JVM SDK를 통해 Rust의 `add`를 호출합니다.
3. Spring이 JSON 숫자 `5`를 반환하면 Swift 클라이언트가 값을 읽어 호출자에게 돌려줍니다.

### 계산기 예제 실행하기

Node.js 22 이상, 안정 버전 Rust, Python 3.11 이상, JDK 17 이상, Gradle 8.11.1, Swift 6 이상이 필요합니다. Rust Inside 저장소 루트에서 실행하세요.

```sh
bash examples/swift-spring-rpc/verify.sh
```

스크립트가 클라이언트와 서버 소스를 생성하고 JVM JAR을 빌드한 뒤, 로컬 임시 포트에 Spring을 띄웁니다. Swift 클라이언트가 응답을 받으면 `5`를 출력합니다. 생성된 파일을 보관하려면 빈 출력 디렉터리를 넘기세요.

```sh
bash examples/swift-spring-rpc/verify.sh /tmp/rust-inside-rpc-example
```

출력 디렉터리의 `swift/`에는 Swift 패키지, `spring/`에는 라우트를 포함한 Spring 프로젝트, `packages/`에는 JVM JAR이 들어 있습니다. 소스만 생성하려면 아래 명령을 실행하세요.

```sh
node scripts/sdk/generate-rpc.mjs examples/swift-spring-rpc/rust-inside.json /tmp/rust-inside-rpc-sources
```

이 로컬 예제는 `api` 모듈과 `jvm` 백엔드를 사용합니다. RPC 생성기는 서버용 동기 함수의 인자와 반환값에 `i32`, `i64`, `String`, 값 없는 열거형, 스칼라나 열거형 필드로 구성된 레코드를 지원합니다. [검증 스크립트](../examples/swift-spring-rpc/verify.sh)

### 로그인한 사용자로 신고하기

Rust에 `report`, `ReportReason`, `ReportReceipt`를 정의합니다. 인증 헤더를 설정해 둔 Swift 클라이언트에는 신고 대상과 사유를 넘깁니다. [Rust API](../examples/swift-spring-report/src/api.rs) · [Swift 호출 코드](../examples/swift-spring-report/swift-example/Sources/RpcExample/main.swift)

```swift
let receipt = try await client.report("post-42", .spam)
print(receipt.reportId)
```

1. Swift가 신고 대상과 사유를 담아 `POST /rpc/report`를 보냅니다. Spring Security가 요청을 인증합니다.
2. 생성된 컨트롤러가 로그인한 사용자와 서버에서 생성한 요청 ID로 `RpcContext`를 만들고 JVM SDK를 통해 Rust를 호출합니다.
3. Rust가 신고 응답을 만들면 Spring 리스너가 H2에 신고를 저장합니다. 컨트롤러는 저장이 끝난 뒤 Swift에 응답을 반환합니다. [인증과 저장 코드](../examples/swift-spring-report/spring/src/main/kotlin/dev/rustinside/rpc/ReportConfiguration.kt)

계산기 예제의 도구와 `curl`을 준비하고 저장소 루트에서 실행하세요. 스크립트는 로컬에서 Spring을 띄우고 테스트 계정 `martin`의 비밀번호를 생성합니다. Swift가 받은 ID가 DB에 저장된 한 건과 일치하는지 확인하고, 비인증 요청의 401과 신고자 ID를 넣은 요청의 400도 확인합니다.

```sh
bash examples/swift-spring-report/verify.sh /tmp/rust-inside-report-example
```

빈 출력 디렉터리를 넘기면 생성된 패키지와 `reports.mv.db` 파일을 보관할 수 있습니다. 경로를 생략하면 임시 디렉터리에서 실행합니다.

신고 예제는 `ios`와 `backend` 양쪽에 `report`를 필수로 선언합니다. 생성 단계에서 Swift 메서드와 Spring 라우트를 검사하고, CI의 **Verify report RPC** 작업에서 Swift 코드를 빌드해 실제로 띄운 Spring 서버를 호출합니다. Rust 함수는 설정한 API 모듈을 통해 공개한 위치 어디에 있어도 됩니다. 실행 중인 서버에 라우트가 빠져 있으면 인증된 요청은 HTTP 404를 받습니다. 새 라우트를 서버에 먼저 배포한 뒤 앱을 올리세요. [신고 API 계약](../examples/swift-spring-report/rust-inside.json) · [CI 워크플로](../.github/workflows/check.yml)

## 내 Rust 프로젝트에서 SDK 배포하기

1. `src/lib.rs`에 `pub mod api;`를 선언하고 공개할 함수나 메서드를 `src/api.rs`에 둡니다. [API 설계](#rust-코어-설계하기)
2. `Cargo.toml` 옆에 `rust-inside.json`을 만들고 `api`, `backend`, 플랫폼별 배포 주소를 적습니다. [설정 예제](#코어-프로젝트-연결)
3. 릴리스 워크플로를 추가하고 GitHub Actions에서 시험 빌드를 실행합니다. [첫 배포 설정](#첫-배포-설정)
4. 배포 토큰을 등록하고 코어에 `v0.1.0` 같은 태그를 푸시합니다. SDK 저장소의 **Releases**에서 버전을 확인하고 패키지 관리자로 설치하세요. [플랫폼별 설치 가이드](#플랫폼별-설치와-사용법)

워크플로는 태그의 Rust 커밋에서 바인딩과 플랫폼별 바이너리를 빌드해 함께 배포합니다. 브라우저용 바이너리는 WebAssembly입니다. 각 릴리스에 빌드에 사용한 코어 커밋을 기록합니다.

## Rust 코어 설계하기

### 선택형 프로젝트 템플릿으로 시작하기

새 저장소에는 [코어 템플릿](../templates/core)을 복사해 `src/client/`, `src/server/`, `src/common/` 구조로 시작할 수 있습니다. 플랫폼 전용 코드가 생기면 `client/`에 하위 모듈을 추가하세요. SDK에서 공개할 함수는 `src/api.rs`에 두면 되고, 기존 프로젝트는 지금 쓰는 구조를 유지할 수 있습니다.

신고 예제는 신고 사유와 응답 타입을 `src/common/`에, 구현을 `src/server/`에 두고 공개 API에서 RPC 함수로 연결합니다. [신고 예제 소스](../examples/swift-spring-report/src)

앱이 전체 문제 ID와 푼 문제 ID를 넘기면 코어가 남은 ID를 순서대로 반환합니다. 공개 함수의 이름과 서명을 유지하면 내부 구현을 여러 모듈이나 crate로 나눠도 같은 방식으로 호출할 수 있습니다.

```rust
// src/lib.rs
mod questions;
pub mod api;

// src/questions.rs
use std::collections::HashSet;

pub(crate) fn unanswered(ids: Vec<String>, answered: &[String]) -> Vec<String> {
    let answered: HashSet<&str> = answered.iter().map(String::as_str).collect();
    ids.into_iter().filter(|id| !answered.contains(id.as_str())).collect()
}

// src/api.rs
pub fn unanswered_ids(ids: Vec<String>, answered: Vec<String>) -> Vec<String> {
    crate::questions::unanswered(ids, &answered)
}
```

`"api": "src/api.rs"`로 설정하면 Swift에서 `unansweredIds`를 호출합니다. 목록을 비교하는 `questions::unanswered`는 `pub(crate)`이므로 호출 범위가 같은 crate로 제한됩니다.

### `pub fn`이면 앱에도 공개되나요?

| 설정 방식 | 플랫폼 SDK에서 직접 호출할 수 있는 함수 |
| --- | --- |
| `api` | crate 루트의 `pub mod api`와 그 아래 공개 모듈에 선언한 함수 중 생성기가 지원하는 `pub fn` |
| `exports` | 설정에 경로를 적은 공개 함수 |
| 기존 iOS `uniffi` | `#[uniffi::export]` 등으로 UniFFI에 공개한 함수 |

SDK는 API 모듈에서 공개한 함수를 노출합니다. Rust 서버가 다른 crate를 Cargo로 직접 가져오면 그 crate의 `pub` 함수도 호출할 수 있습니다.

`api`나 `exports`에 동기 함수를 공개할 때 `HashMap`, `Option<T>`, 사용자 정의 오류를 지원 타입으로 바꿔 전달하세요. 비동기 클라이언트는 `Result<Me, String>`을 반환할 수 있습니다. iOS 전용 UniFFI 프로젝트는 기존 레코드와 오류 타입을 Swift에서 쓸 수 있습니다. [지원하는 함수 형태](#sdk에서-호출할-함수-지정하기) · [기존 UniFFI로 iOS 배포](#ios용-swift-패키지만-배포하기)

코어와 의존성은 대상 플랫폼에서 빌드되고 동작해야 합니다. 브라우저용 Wasm에서 `std::fs`는 컴파일돼도 파일 읽기에 실패합니다. 플랫폼에서 파일을 읽어 Rust에 데이터를 넘기세요. `#[rust_inside::server]`로 서버 SDK에만 함수를 노출할 수 있고, OS 전용 코드는 `cfg`, 타깃별 의존성, 별도 crate로 나눌 수 있습니다. 공통 로직은 Rust 단위 테스트, 플랫폼 기능은 해당 SDK에서 확인하세요. [Rust의 Wasm 타깃 지원 범위](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)

## 코어 프로젝트 연결

`Cargo.toml` 옆에 `rust-inside.json`을 두고 `api`에 공개 모듈 경로를 적으세요. `repositories`의 주소는 팀의 배포 저장소로 바꿉니다. [샘플 설정 파일](https://github.com/Rust-Inside/sample-rust-core/blob/main/rust-inside.json)

```json
{
  "api": "src/api.rs",
  "backend": "jvm",
  "repositories": {
    "ios": "your-org/my-core-ios",
    "android": "your-org/my-core-android",
    "flutter": "your-org/my-core-flutter",
    "web": "your-org/my-core-web",
    "backend": "your-org/my-core-server"
  }
}
```

- 필수 항목인 `backend`에는 `jvm`(JAR), `node`(npm), `rust`(Cargo로 원본 crate 사용) 중 하나를 넣습니다. `rust`를 고르면 `repositories.backend`는 생략하거나 `null`로 둡니다.
- 주소는 `owner/repo` 또는 GitHub HTTPS URL을 씁니다. 키를 생략하거나 `null`로 설정하면 건너뜁니다. 같은 주소를 쓰는 플랫폼의 패키지는 한 릴리스에 모입니다.
- 배포 주소를 설정한 플랫폼에 공개 API가 없으면 경고를 출력하고 해당 패키지를 건너뜁니다. SDK에 반드시 들어가야 할 메서드는 `"requiredApi": {"ios": ["AccountClient.getMe"]}`처럼 생성된 이름을 적으세요. 필수 메서드가 빠지면 생성기가 실패하므로 릴리스 워크플로와 생성기를 실행하는 CI에서 잡힙니다.
- 워크스페이스에서는 `"crate": "crates/my-core/Cargo.toml"`로 빌드할 멤버를 지정합니다. SDK 이름은 Cargo 패키지 이름을 따르며 `name`으로 바꿀 수 있습니다.
- 편집기 자동 완성에는 코어 저장소에 스키마를 복사하고 `"$schema": "./rust-inside.schema.json"`을 추가하세요. [설정 스키마](../rust-inside.schema.json)

<a id="어떤-함수가-패키지에-들어가나요"></a>

### SDK에서 호출할 함수 지정하기

`api` 모듈의 공개 API는 기본적으로 설정한 모든 SDK에서 쓸 수 있습니다. `exports`로 동기 함수를 고를 때는 경로, 인자, 반환 타입을 적으세요.

```rust
// src/api.rs
pub fn api_version() -> u32 { 1 }

#[rust_inside::app]
pub mod profile {
    pub fn avatar_size() -> u32 { 48 }

    #[rust_inside::web]
    pub fn share_path(handle: String) -> String { format!("/users/{handle}") }
}
```

`apiVersion()`은 모든 대상에 배포됩니다. `avatarSize()`는 모듈의 `app`을 따라 iOS·Android·Flutter에, `sharePath(handle)`은 함수의 `web`을 따라 브라우저에만 배포됩니다.

코어의 `Cargo.toml`에 공개 Rust Inside 저장소의 매크로 의존성을 추가하세요. [속성 매크로](../annotations)

```toml
[dependencies]
rust_inside = { package = "rust-inside-annotations", git = "https://github.com/Rust-Inside/rust-inside.git" }
```

`app`, `ios`, `android`, `flutter`, `web`, `server`는 함수, 모듈, 클라이언트 `impl`, 공개 trait에 붙일 수 있습니다. `app`과 `web`을 함께 지정하면 앱과 웹에 공개됩니다. `exports`에서는 항목의 `"platforms": ["app", "web"]`으로 같은 대상을 지정합니다.

공개 구조체와 같은 모듈에 `pub fn new(...) -> Self`와 비동기 메서드를 둡니다. 샘플의 `pub async fn get_me(&self) -> Result<Me, String>`에서 `Me`의 필드는 공개입니다. 플랫폼에 메서드가 하나라도 공개되면 생성자도 함께 노출됩니다.

동기 함수의 인자·반환값, 클라이언트 메서드의 인자, 레코드 필드에는 `bool`, 8~64비트 정수, `f32`, `f64`, `String`, `Vec<u8>`, `Vec<u32>`, `Vec<String>`을 쓸 수 있습니다. 동기 함수는 `()`도 반환할 수 있습니다.

### iOS용 Swift 패키지만 배포하기

iOS 전용 워크플로는 SDK 저장소의 버전 태그에 Swift 소스와 XCFramework를 함께 올립니다. 저장소가 비공개여도 Git 읽기 권한이 있으면 SwiftPM으로 설치할 수 있습니다.

UniFFI로 API를 공개한 경우 아래처럼 해당 crate 경로를 지정하세요.

```json
{
  "backend": "rust",
  "uniffi": { "crate": "mobile-api/Cargo.toml" },
  "repositories": { "ios": "my-team/thermometer-ios-sdk" }
}
```

이 crate는 `staticlib`을 빌드해야 합니다. Rust Inside는 Cargo 잠금 파일의 UniFFI 버전과 기존 모듈명·함수 서명으로 Swift 바인딩을 생성합니다. `api`나 `exports`도 같은 워크플로를 쓸 수 있습니다.

코어에 iOS 워크플로를 복사하고 Rust Inside 커밋을 고정하세요. SDK 저장소에 쓰기 권한을 준 배포 키의 개인 키를 코어의 Actions 시크릿 `RUST_INSIDE_IOS_PUBLISH_KEY`에 넣습니다. 공개 도구는 GitHub 기본 토큰으로 읽습니다. 비공개 도구를 쓰면 체크아웃할 `repository`를 바꾸고 읽기 키를 `RUST_INSIDE_TOOLS_SSH_KEY`에 넣으세요.

코어에 `vX.Y.Z` 태그를 푸시하면 워크플로가 코어 테스트와 Swift 패키지 빌드·링크 검사를 거쳐 SDK에도 같은 태그를 게시합니다. 패키지는 iOS 18 이상 기기와 arm64·x86_64 시뮬레이터를 지원합니다. [iOS 워크플로 템플릿](../templates/release-ios.yml)

## 첫 배포 설정

먼저 각 SDK 저장소의 기본 브랜치에 첫 커밋을 만드세요. 공개 Rust Inside 워크플로는 비공개 코어와 SDK 저장소에도 쓸 수 있습니다. 비공개 SDK를 설치하는 팀은 해당 저장소에 읽기 권한이 필요합니다.

1. 코어의 `.github/workflows/release.yml`에 템플릿을 복사하세요. 설정 파일이 루트에 없으면 `with.manifest`로 경로를 지정합니다. [워크플로 템플릿](../templates/release.yml)
2. 코어 저장소의 **Settings → Secrets and variables → Actions**에 배포 토큰을 넣으세요. 공개 도구는 GitHub 기본 토큰으로 읽습니다.

| 시크릿 | 접근할 저장소 | 권한 |
| --- | --- | --- |
| `RUST_INSIDE_RELEASE_TOKEN` | 배포할 SDK 저장소 | `Contents: Read and write` |
| `RUST_INSIDE_TOOLS_TOKEN` (비공개 도구에만 필요) | 팀에서 관리하는 비공개 Rust Inside 저장소 | `Contents: Read` |

비공개 Rust Inside를 쓰는 경우 호출 주소를 바꾸고 **Settings → Actions → General → Access**에서 비공개 코어의 접근을 허용하세요. 공개 코어에서 호출할 워크플로는 공개 상태여야 합니다. [GitHub의 워크플로 접근 규칙](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#access-to-reusable-workflows)

시험 빌드는 읽기 권한만으로 가능합니다. **Actions → Release SDKs → Run workflow**에 버전을 입력하세요. 실제 배포는 코어 태그를 푸시하면 시작합니다.

```sh
git tag v0.1.0
git push origin v0.1.0
```

공개 API가 있는 플랫폼의 빌드가 모두 끝나면 각 SDK 저장소에 같은 버전을 릴리스합니다. 메서드 이름과 인자·반환 타입은 코어 저장소의 Actions 실행 요약에 표시됩니다. [릴리스 워크플로](../.github/workflows/release-sdk.yml)

## Node.js나 Rust 서버에서 쓰려면

공개 샘플의 서버 패키지는 JVM JAR입니다. **Node.js**를 써 보려면 `sample-rust-core` 복사본에서 `backend`를 `node`로 바꾸고, `repositories.backend`에 `your-org/sample-node-sdk`처럼 직접 관리하는 저장소를 지정하세요. 배포 파일은 CommonJS 패키지(`<name>-node-<version>.tgz`)입니다.

릴리스 템플릿으로 `v0.1.1` 같은 새 태그를 배포하세요. 샘플의 수동 워크플로를 쓰면 `release_tag`에 새 태그를 넣고 `RUST_INSIDE_RELEASE_TOKEN`을 등록합니다. 배포 후 서버에 패키지를 설치하세요.

```sh
gh release download v0.1.1 --repo your-org/sample-node-sdk \
  --pattern 'sample-rust-core-node-0.1.1.tgz'
npm install ./sample-rust-core-node-0.1.1.tgz
```

```js
const { meResponseJson } = require('sample-rust-core-node');
const body = meResponseJson('u42', 'martin', 'Martin');
```

CI는 Node 22로 패키지를 검사합니다. Node·npm 최소 버전은 지정하지 않습니다.

**Rust 서버**는 코어 태그를 Cargo 의존성에 지정합니다. Cargo가 소스를 빌드하므로 컴파일러 버전은 코어와 의존성에 맞추세요.

```toml
[dependencies]
sample-rust-core = { git = "https://github.com/Rust-Inside/sample-rust-core.git", tag = "v0.1.0" }
```

```rust
use sample_rust_core::api::AccountClient;

async fn display_name(api_origin: String, authorization: String) -> Result<String, String> {
    let client = AccountClient::new(api_origin, authorization);
    Ok(client.get_me().await?.display_name)
}
```

## 라이선스

Rust Inside는 [MIT 라이선스](../LICENSE)로 배포합니다.
