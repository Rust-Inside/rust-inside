# Rust Inside

[English](README.md) | [한국어](README.ko.md)

Rust Inside는 Rust 라이브러리를 각 플랫폼에서 바로 쓸 수 있는 패키지로 빌드하고 배포합니다. 코어 팀이 공개할 API와 배포할 저장소를 정하고 버전 태그를 푸시하면, 각 팀은 미리 빌드된 SDK를 받아 씁니다. iOS 팀은 SwiftPM으로 원하는 버전의 Swift 패키지를 설치합니다.

샘플 코어의 `get_me`는 인증 헤더를 붙여 `GET /v1/me`를 요청합니다. 앱에서는 SDK의 `account.getMe()`를 호출하면 로그인한 사용자의 프로필을 받습니다. [샘플 코어](https://github.com/Rust-Inside/sample-rust-core/blob/main/README.ko.md) · [Rust 구현](https://github.com/Rust-Inside/sample-rust-core/blob/main/src/api.rs)

## Rust 코어 설계하기

앱에 아직 풀지 않은 문제를 보여준다고 해봅시다. 앱은 전체 문제 ID와 이미 푼 ID를 넘기고, 코어는 남은 ID를 원래 순서대로 돌려줍니다. 공개 함수의 이름과 서명을 유지하면 내부 구현을 여러 모듈이나 crate로 나눠도 앱의 호출 코드는 그대로입니다.

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

`"api": "src/api.rs"`로 설정하면 Swift에서 호출할 함수는 `unansweredIds` 하나입니다. 목록을 비교하는 `questions::unanswered`는 `pub(crate)`이므로 같은 crate 안에서만 호출할 수 있습니다.

### `pub fn`이면 앱에도 공개되나요?

| 설정 방식 | 플랫폼 SDK에서 직접 호출할 수 있는 함수 |
| --- | --- |
| `api` | crate 루트의 `pub mod api`와 그 아래 공개 모듈에 선언한 함수 중 생성기가 지원하는 `pub fn` |
| `exports` | 설정에 경로를 적은 공개 함수 |
| 기존 iOS `uniffi` | `#[uniffi::export]` 등으로 UniFFI에 공개한 함수 |

API 모듈이 다른 crate의 `pub` 함수를 호출해도 SDK에서 보이는 건 API 모듈이 공개한 함수뿐입니다. Rust 서버가 그 crate를 Cargo로 직접 가져가면 해당 crate의 공개 API를 호출할 수 있습니다.

내부에서 쓰는 타입과 SDK에서 주고받을 타입도 따로 정할 수 있습니다. `api`와 `exports`로 동기 함수를 공개할 때는 `HashMap`, `Option<T>`, 사용자 정의 오류를 생성기가 지원하는 타입으로 바꿔 전달하세요. 비동기 클라이언트는 `Result<Me, String>`을 반환할 수 있고, iOS 전용 UniFFI 프로젝트는 기존 레코드와 오류 타입을 Swift에서 그대로 쓸 수 있습니다. [지원하는 함수 형태](#sdk에서-호출할-함수-지정하기) · [기존 UniFFI로 iOS 배포](#ios용-swift-패키지만-배포하기)

코어와 의존성은 선택한 타깃에서 컴파일되고 실제로 동작해야 합니다. 예를 들어 브라우저용 Wasm에서 `std::fs`는 컴파일돼도 파일을 읽으면 오류를 반환합니다. 이 경우 플랫폼에서 파일을 읽어 공통 로직에 데이터를 넘기세요. `#[rust_inside::server]`는 서버 SDK에 함수를 공개하는 속성입니다. OS 전용 코드와 의존성은 Rust의 `cfg`, Cargo의 타깃별 의존성, 별도 crate로 나눌 수 있습니다. 공통 규칙은 Rust에서 단위 테스트하고, 플랫폼 기능은 해당 SDK에서 호출해 확인하세요. [Rust의 Wasm 타깃 지원 범위](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)

## 플랫폼별 설치와 사용법

| 플랫폼 | 앱이나 서버에 추가할 패키지 | 지원 환경 | 설치와 호출 예제 |
| --- | --- | --- | --- |
| iOS | SwiftPM의 `SampleRustCoreSDK` | iOS 18 이상, arm64 기기·시뮬레이터, Swift tools 6.0 | [Swift 가이드](https://github.com/Rust-Inside/sample-ios-sdk/blob/main/README.ko.md) |
| Android | Gradle의 `sample-rust-core-android` AAR | API 23 이상, arm64-v8a·x86_64 | [Android 가이드](https://github.com/Rust-Inside/sample-android-sdk/blob/main/README.ko.md) |
| Flutter | pub의 `sample_rust_core_flutter` Git 패키지 | iOS·Android, Flutter 3.38 이상, Dart 3.10 이상 4 미만 | [Dart 가이드](https://github.com/Rust-Inside/sample-flutter-sdk/blob/main/README.ko.md) |
| 웹 | npm의 `sample-rust-core-web` | ES 모듈과 WebAssembly를 지원하는 브라우저 | [웹 가이드](https://github.com/Rust-Inside/sample-web-sdk/blob/main/README.ko.md) |
| Kotlin/Spring | Gradle의 `sample-rust-core-jvm` JAR | JVM 17 이상, Linux glibc(x86-64·ARM64) 또는 Apple Silicon macOS | [JVM 서버 가이드](https://github.com/Rust-Inside/sample-server-sdk/blob/main/README.ko.md) |

샘플 SDK 저장소의 **Releases**에서 설치할 버전과 패키지를 확인하세요. 각 팀은 비공개 코어와 SDK 저장소에서도 공개 Rust Inside 워크플로를 사용할 수 있습니다. 비공개 SDK를 설치하는 팀에는 해당 저장소의 읽기 권한이 필요합니다.

## 코어 프로젝트 연결

Rust 라이브러리의 `Cargo.toml` 옆에 `rust-inside.json`을 둡니다. `api`에는 SDK로 공개할 모듈의 경로를, `repositories`에는 플랫폼별 SDK를 배포할 GitHub 저장소를 적습니다.

```json
{
  "api": "src/api.rs",
  "backend": "jvm",
  "repositories": {
    "ios": "Rust-Inside/sample-ios-sdk",
    "android": "Rust-Inside/sample-android-sdk",
    "flutter": "Rust-Inside/sample-flutter-sdk",
    "web": "Rust-Inside/sample-web-sdk",
    "backend": "Rust-Inside/sample-server-sdk"
  }
}
```

- `backend`는 필수입니다. `jvm`은 JAR, `node`는 Node.js용 npm 패키지를 만듭니다. Rust 서버가 Cargo로 원본 crate를 참조하면 `rust`를 선택하고 `repositories.backend`를 생략하거나 `null`로 둡니다.
- 저장소 주소는 `owner/repo` 또는 GitHub HTTPS 주소로 적습니다. 키를 생략하거나 `null`로 둔 플랫폼은 건너뜁니다. 여러 플랫폼에 같은 주소를 쓰면 패키지가 한 릴리스에 모입니다.
- 워크스페이스에서는 `"crate": "crates/my-core/Cargo.toml"`로 빌드할 멤버를 지정합니다. 패키지 이름은 Cargo 패키지 이름을 따릅니다. 다른 이름으로 배포하려면 `name`을 지정하세요.
- 편집기에서 설정값을 자동 완성하려면 코어 저장소에 스키마를 복사하고 `"$schema": "./rust-inside.schema.json"`을 추가하세요. [설정 스키마](rust-inside.schema.json)

<a id="어떤-함수가-패키지에-들어가나요"></a>

### SDK에서 호출할 함수 지정하기

`api` 모듈에서 플랫폼을 따로 지정하지 않은 공개 API는 설정한 모든 SDK에서 쓸 수 있습니다. 기존 동기 함수 중 일부만 골라 공개하려면 `exports` 배열에 함수 경로, 인자와 반환 타입을 적으세요.

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

`apiVersion()`은 설정한 모든 SDK에서 호출할 수 있습니다. `avatarSize()`는 모듈의 `app`을 따라 iOS·Android·Flutter에서, `sharePath(handle)`은 함수의 `web`을 따라 브라우저에서만 호출할 수 있습니다.

이 속성을 쓰려면 코어의 `Cargo.toml`에 매크로 의존성을 추가하세요. Cargo가 공개 Rust Inside 저장소에서 매크로를 가져옵니다. [속성 매크로](annotations)

```toml
[dependencies]
rust_inside = { package = "rust-inside-annotations", git = "https://github.com/Rust-Inside/rust-inside.git" }
```

`app`, `ios`, `android`, `flutter`, `web`, `server`를 함수·모듈·클라이언트의 `impl`이나 공개 trait에 붙일 수 있습니다. 같은 선언에 `app`과 `web`을 함께 붙이면 앱과 웹에서 모두 호출할 수 있습니다. `exports` 방식에서는 항목에 `"platforms": ["app", "web"]`을 지정합니다.

클라이언트는 공개 구조체와 같은 모듈에 `pub fn new(...) -> Self`와 비동기 메서드를 둡니다. 샘플의 `pub async fn get_me(&self) -> Result<Me, String>`에서 `Me`는 공개 필드를 가진 레코드입니다. 해당 플랫폼에 메서드가 하나라도 있으면 생성자도 함께 제공됩니다.

동기 함수의 인자·반환값, 클라이언트 메서드의 인자, 레코드 필드에는 `bool`, 8~64비트 정수, `f32`, `f64`, `String`, `Vec<u8>`, `Vec<u32>`, `Vec<String>`을 쓸 수 있습니다. 동기 함수는 `()`도 반환할 수 있습니다.

### iOS용 Swift 패키지만 배포하기

iOS 전용 워크플로는 SDK 저장소의 버전 태그에 Swift 소스와 XCFramework를 함께 올립니다. 저장소가 비공개여도 Git 읽기 권한이 있으면 SwiftPM으로 설치할 수 있습니다.

이미 UniFFI로 공개한 API가 있다면 해당 crate의 경로를 지정하세요. 온도 센서 라이브러리의 설정 예시입니다.

```json
{
  "backend": "rust",
  "uniffi": { "crate": "mobile-api/Cargo.toml" },
  "repositories": { "ios": "my-team/thermometer-ios-sdk" }
}
```

이 crate는 `staticlib`을 빌드해야 합니다. Rust Inside는 Cargo 잠금 파일에 기록된 UniFFI 버전으로 Swift 바인딩을 생성합니다. Swift 모듈명과 함수 서명은 기존 UniFFI 설정을 따릅니다. `api`나 `exports`를 쓰는 라이브러리도 같은 워크플로로 배포할 수 있습니다.

코어 저장소에 iOS 워크플로를 복사하고 사용할 Rust Inside 커밋을 고정하세요. SDK 저장소에 쓰기 권한이 있는 배포 키를 등록하고, 그 개인 키를 코어 저장소의 Actions 시크릿 `RUST_INSIDE_IOS_PUBLISH_KEY`에 넣습니다. 워크플로는 GitHub 기본 토큰으로 공개 도구를 읽습니다. Rust Inside를 팀의 비공개 저장소에서 관리한다면 체크아웃할 `repository`를 바꾸고 해당 저장소의 읽기 키를 `RUST_INSIDE_TOOLS_SSH_KEY`에 등록하세요.

코어에 `vX.Y.Z` 태그를 푸시하면 코어 테스트, Swift 패키지 빌드와 링크 검사를 거쳐 SDK 저장소에 같은 태그를 게시합니다. 패키지에는 iOS 18 이상 기기와 arm64·x86_64 시뮬레이터용 바이너리가 들어갑니다. [iOS 워크플로 템플릿](templates/release-ios.yml)

## 첫 배포 설정

여러 플랫폼에 배포하려면 먼저 각 SDK 저장소의 기본 브랜치에 첫 커밋을 만드세요.

1. 코어 저장소의 `.github/workflows/release.yml`에 워크플로 템플릿을 복사합니다. 설정 파일이 루트에 없으면 `with.manifest`로 경로를 지정하세요. [워크플로 템플릿](templates/release.yml)
2. 코어 저장소의 **Settings → Secrets and variables → Actions**에 배포 토큰을 등록합니다. 공개 Rust Inside 도구는 GitHub 기본 토큰으로 읽을 수 있습니다.

| 시크릿 | 접근할 저장소 | 권한 |
| --- | --- | --- |
| `RUST_INSIDE_RELEASE_TOKEN` | 배포할 SDK 저장소 | `Contents: Read and write` |
| `RUST_INSIDE_TOOLS_TOKEN` (비공개 도구에만 필요) | 팀에서 관리하는 비공개 Rust Inside 저장소 | `Contents: Read` |

조직에서 Rust Inside를 비공개로 관리한다면 호출 워크플로의 주소를 그 저장소로 바꾸고, **Settings → Actions → General → Access**에서 비공개 코어 저장소의 접근을 허용하세요. 공개 코어에서 호출할 때는 도구 워크플로도 공개 상태여야 합니다. [GitHub의 워크플로 접근 규칙](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#access-to-reusable-workflows)

**Actions → Release SDKs → Run workflow**에 버전을 입력하면 읽기 권한만으로 빌드와 패키징을 시험할 수 있습니다. 배포할 때는 코어 저장소에 태그를 푸시하세요.

```sh
git tag v0.1.0
git push origin v0.1.0
```

Rust Inside는 공개할 API가 있는 플랫폼만 빌드합니다. 패키지 빌드가 모두 끝나면 각 SDK 저장소에 같은 버전을 릴리스합니다. 해당 버전의 메서드 이름, 인자와 반환 타입은 코어 저장소의 Actions 실행 요약에서 확인하세요. [릴리스 워크플로](.github/workflows/release-sdk.yml)

## Node.js나 Rust 서버에서 쓰려면

**Node.js**를 선택하면 `repositories.backend` 저장소에 서버 SDK를 CommonJS 패키지(`<name>-node-<version>.tgz`)로 배포합니다. 샘플의 기본 설정은 JVM입니다. `node`로 바꿔 버전 `0.1.0`을 릴리스했다면 서버에서 이렇게 설치합니다.

```sh
gh release download v0.1.0 --repo Rust-Inside/sample-server-sdk \
  --pattern 'sample-rust-core-node-0.1.0.tgz'
npm install ./sample-rust-core-node-0.1.0.tgz
```

```js
const { meResponseJson } = require('sample-rust-core-node');
const body = meResponseJson('u42', 'martin', 'Martin');
```

CI는 Node 22로 패키지를 검사합니다. Node·npm 최소 버전은 지정하지 않습니다.

**Rust 서버**는 코어 라이브러리를 직접 씁니다. Cargo 의존성에 사용할 태그를 지정하세요. Cargo가 소스를 빌드하므로 필요한 Rust 컴파일러 버전은 코어와 의존성에 따라 달라집니다.

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

Rust Inside는 [MIT 라이선스](LICENSE)로 배포합니다.
