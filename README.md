# Rust Inside

[English](README.md) | [한국어](README.ko.md)

Rust Inside builds and publishes platform packages from a Rust library. The core team chooses the public API and the destination repositories. Pushing a version tag releases the SDKs to those repositories. An iOS developer, for example, installs the Swift package with Swift Package Manager and calls the Rust code from Swift.

In the sample library, `get_me` sends an authenticated `GET /v1/me` request. The app calls `account.getMe()` on the SDK to read the signed-in user's profile. [Sample Rust library](https://github.com/Rust-Inside/sample-rust-core) · [Rust implementation](https://github.com/Rust-Inside/sample-rust-core/blob/main/src/api.rs)

<a id="rust-코어-설계하기"></a>

## Design the Rust library

Suppose an app needs to show unanswered questions. It passes the full list of question IDs and the IDs the user has answered. The library returns the remaining IDs in their original order. You can split the implementation across modules or crates as it grows, while keeping the same public function and call site.

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

With `"api": "src/api.rs"`, the Swift SDK exposes one function, `unansweredIds`. The `questions::unanswered` helper is `pub(crate)`, so only code in the same crate can call it.

<a id="pub-fn이면-앱에도-공개되나요"></a>

### Which public functions does the SDK expose?

| Export setting | Functions available to the platform SDK |
| --- | --- |
| `api` | Supported `pub fn` declarations in the crate root's `pub mod api` and its public submodules |
| `exports` | Public functions whose paths you list in the manifest |
| Existing iOS `uniffi` crate | Functions you expose through UniFFI, for example with `#[uniffi::export]` |

An API module can call a `pub` function from another crate. With the `api` setting, the SDK exposes the function declared in the API module. A Rust server that depends on the other crate directly through Cargo can use that crate's public API.

Choose types that the platform can receive. When exposing synchronous functions through `api` or `exports`, convert internal types such as `HashMap`, `Option<T>`, and custom errors to supported types at the API boundary. An async client method can return `Result<Me, String>`. An iOS-only project with an existing UniFFI API can keep its records and typed errors in Swift. [Supported signatures](#choose-which-platforms-can-call-a-function) · [iOS-only releases](#publish-a-swift-package-for-ios-only)

Check that the library and its dependencies build and run on each target. For example, `std::fs` compiles for browser Wasm, but trying to read a file returns an error. The app can read the file and pass its contents to Rust. Use `#[rust_inside::server]` to expose a function in the server SDK. Use Rust's `cfg`, Cargo target-specific dependencies, or a separate crate for code that requires a particular OS. Unit-test the shared logic in Rust and exercise platform features through the SDK. [Rust Wasm target support](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)

<a id="플랫폼별-설치와-사용법"></a>

## Install a platform SDK

| Platform | Package to install | Supported environment | Installation and usage |
| --- | --- | --- | --- |
| iOS | `SampleRustCoreSDK` via SwiftPM | iOS 18+, arm64 devices and simulators, Swift tools 6.0 | [Swift guide](https://github.com/Rust-Inside/sample-ios-sdk#readme) |
| Android | `sample-rust-core-android` AAR via Gradle | Android API 23+, arm64-v8a and x86_64 | [Android guide](https://github.com/Rust-Inside/sample-android-sdk#readme) |
| Flutter | `sample_rust_core_flutter` Git package via pub | iOS and Android, Flutter 3.38+, Dart 3.10 or later in the 3.x series | [Dart guide](https://github.com/Rust-Inside/sample-flutter-sdk#readme) |
| Web | `sample-rust-core-web` via npm | Browsers with ES modules and WebAssembly | [Web guide](https://github.com/Rust-Inside/sample-web-sdk#readme) |
| Kotlin/Spring | `sample-rust-core-jvm` JAR via Gradle | JVM 17+ on Linux with glibc (x86-64 or ARM64) or Apple Silicon macOS | [JVM server guide](https://github.com/Rust-Inside/sample-server-sdk#readme) |

Open **Releases** in a sample SDK repository to find the available versions and packages. You can use the public Rust Inside workflow with your own private core and SDK repositories. For a private SDK, consumers need read access to its repository.

<a id="코어-프로젝트-연결"></a>

## Connect your Rust project

Place `rust-inside.json` next to the library's `Cargo.toml`. Set `api` to the Rust module you want to expose and list each SDK's destination on GitHub under `repositories`.

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

- `backend` is required. Choose `jvm` for a JAR or `node` for a Node.js npm package. If a Rust server uses the library directly through Cargo, choose `rust` and omit `repositories.backend` or set it to `null`.
- Use `owner/repo` or a GitHub HTTPS URL for each destination. Omit a key or set it to `null` to skip that platform. If several platforms share a repository, their packages appear in the same release.
- In a Cargo workspace, set `"crate": "crates/my-core/Cargo.toml"` to select the member to build. The package name defaults to the Cargo package name. Set `name` to publish under a different name.
- For editor completion, copy the schema into the core repository and add `"$schema": "./rust-inside.schema.json"` to the manifest. [Configuration schema](rust-inside.schema.json)

<a id="어떤-함수가-패키지에-들어가나요"></a>
<a id="sdk에서-호출할-함수-지정하기"></a>

### Choose which platforms can call a function

A supported public API in the `api` module is available to every configured SDK by default. To publish a selection of existing synchronous functions, list their paths, arguments, and return types in `exports`.

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

Every configured SDK exposes `apiVersion()`. The module's `app` attribute makes `avatarSize()` available on iOS, Android, and Flutter. The `web` attribute on `sharePath(handle)` makes that function available only in the browser.

To use these attributes, add the macro dependency to the library's `Cargo.toml`. Cargo fetches it from the public Rust Inside repository. [Attribute macros](annotations)

```toml
[dependencies]
rust_inside = { package = "rust-inside-annotations", git = "https://github.com/Rust-Inside/rust-inside.git" }
```

Apply `app`, `ios`, `android`, `flutter`, `web`, or `server` to a function, module, client `impl`, or public trait. Use both `app` and `web` on a declaration to expose it to mobile and web SDKs. For an `exports` entry, set `"platforms": ["app", "web"]`.

For a client, put the public struct, its `pub fn new(...) -> Self` constructor, and its async methods in the same module. The sample's `pub async fn get_me(&self) -> Result<Me, String>` returns a record with public fields. A platform SDK includes the constructor when it exposes at least one client method.

Synchronous function arguments and return values, client method arguments, and record fields support `bool`, 8- to 64-bit integers, `f32`, `f64`, `String`, `Vec<u8>`, `Vec<u32>`, and `Vec<String>`. Synchronous functions can also return `()`.

<a id="ios용-swift-패키지만-배포하기"></a>

### Publish a Swift package for iOS only

The iOS workflow puts the Swift source and XCFramework in the same Git tag in the SDK repository. SwiftPM can install the package from a private repository with Git read access.

If your library already exposes an API through UniFFI, point to that crate. A thermometer project's manifest might look like this.

```json
{
  "backend": "rust",
  "uniffi": { "crate": "mobile-api/Cargo.toml" },
  "repositories": { "ios": "my-team/thermometer-ios-sdk" }
}
```

The crate must produce a `staticlib`. Rust Inside generates Swift bindings with the UniFFI version in the Cargo lockfile, using the crate's configured module name and function signatures. The same workflow also accepts libraries that use `api` or `exports`.

Copy the iOS workflow into the core repository and pin it to a Rust Inside commit. Give a deploy key write access to the destination SDK repository and save its private key as `RUST_INSIDE_IOS_PUBLISH_KEY` in the core repository's Actions secrets. The workflow reads the public tools using its built-in GitHub token. If your team hosts a private copy of Rust Inside, change the checkout's `repository` and set `RUST_INSIDE_TOOLS_SSH_KEY` to a read key for that copy.

Push a `vX.Y.Z` tag to test the core, build and link-check the Swift package, and publish the same tag to the SDK repository. The package includes binaries for iOS 18+ devices and arm64 and x86_64 simulators. [iOS workflow template](templates/release-ios.yml)

<a id="첫-배포-설정"></a>

## Set up your first multiplatform release

Create an initial commit on the default branch of each destination repository.

1. Copy the workflow template to `.github/workflows/release.yml` in the core repository. If the manifest is outside the root directory, set its path with `with.manifest`. [Workflow template](templates/release.yml)
2. Add the publish token under **Settings → Secrets and variables → Actions** in the core repository. The built-in GitHub token can read the public Rust Inside tools.

| Secret | Repository | Permission |
| --- | --- | --- |
| `RUST_INSIDE_RELEASE_TOKEN` | Destination SDK repositories | `Contents: Read and write` |
| `RUST_INSIDE_TOOLS_TOKEN` (private tools only) | Your private copy of Rust Inside | `Contents: Read` |

If your organization hosts a private copy of Rust Inside, point the caller workflow at that repository and allow access for your private core repository under **Settings → Actions → General → Access**. Public core repositories need a public reusable workflow. [GitHub workflow access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#access-to-reusable-workflows)

For a dry run, enter a version under **Actions → Release SDKs → Run workflow**. This builds and packages the SDKs using read access alone. To publish, push a tag from the core repository.

```sh
git tag v0.1.0
git push origin v0.1.0
```

Rust Inside builds the configured platforms that have an API to expose. Once all their packages have built, it publishes the same version to each SDK repository. The Actions run summary in the core repository lists the method names, arguments, and return types for that version. [Release workflow](.github/workflows/release-sdk.yml)

<a id="nodejs나-rust-서버에서-쓰려면"></a>

## Use the library from a Node.js or Rust server

With the **Node.js** backend, Rust Inside publishes the server SDK as a CommonJS package named `<name>-node-<version>.tgz` in the `repositories.backend` repository. The sample uses JVM by default. If you switch it to `node` and release version `0.1.0`, install the package in the server project as follows.

```sh
gh release download v0.1.0 --repo Rust-Inside/sample-server-sdk \
  --pattern 'sample-rust-core-node-0.1.0.tgz'
npm install ./sample-rust-core-node-0.1.0.tgz
```

```js
const { meResponseJson } = require('sample-rust-core-node');
const body = meResponseJson('u42', 'martin', 'Martin');
```

CI tests the package with Node 22. The package does not specify a minimum Node or npm version.

A **Rust server** can depend on the library directly. Pin its Git tag in `Cargo.toml`. Cargo builds the source, so the required Rust version depends on the library and its dependencies.

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

## License

Rust Inside is available under the [MIT License](LICENSE).
