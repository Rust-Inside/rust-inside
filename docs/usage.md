# Use Rust Inside

[English](usage.md) | [한국어](usage.ko.md) | [Repository overview](../README.md)

Start with the published SDK, then use the release workflow below to package your own Rust library.

<a id="플랫폼별-설치와-사용법"></a>

## Install a platform SDK

The sample packages are published as `v0.1.0`.

| Platform | Package to install | Supported environment | Installation and usage |
| --- | --- | --- | --- |
| iOS | `SampleRustCoreSDK` via SwiftPM | iOS 18+, arm64 devices and simulators, Swift tools 6.0 | [Swift guide](https://github.com/Rust-Inside/sample-ios-sdk#readme) |
| Android | `sample-rust-core-android` AAR via Gradle | Android API 23+, arm64-v8a and x86_64 | [Android guide](https://github.com/Rust-Inside/sample-android-sdk#readme) |
| Flutter | `sample_rust_core_flutter` Git package via pub | iOS and Android, Flutter 3.38+, Dart 3.10 or later in the 3.x series | [Dart guide](https://github.com/Rust-Inside/sample-flutter-sdk#readme) |
| Web | `sample-rust-core-web` via npm | Browsers with ES modules and WebAssembly | [Web guide](https://github.com/Rust-Inside/sample-web-sdk#readme) |
| Kotlin/Spring | `sample-rust-core-jvm` JAR via Gradle | JVM 17+ on Linux with glibc (x86-64 or ARM64) or Apple Silicon macOS | [JVM server guide](https://github.com/Rust-Inside/sample-server-sdk#readme) |

### Fetch a profile from Swift

In Xcode, open **File → Add Package Dependencies** and enter `https://github.com/Rust-Inside/sample-ios-sdk.git`. Set **Exact Version** to `0.1.0` and add `SampleRustCoreSDK` to your app target. SwiftPM downloads the prebuilt XCFramework. [iOS release v0.1.0](https://github.com/Rust-Inside/sample-ios-sdk/releases/tag/v0.1.0)

```swift
import SampleRustCoreSDK

func displayName(apiOrigin: String, accessToken: String) async throws -> String {
    let account = AccountClient(baseUrl: apiOrigin, authorization: "Bearer \(accessToken)")
    let profile = try await account.getMe()
    return profile.displayName
}
```

Pass your account server's origin and the user's access token. The Swift binding runs Rust's `AccountClient::get_me` inside the app. Rust sends `GET /v1/me` with the authorization header and decodes the response. Your server handles the route, authenticates the request, and returns `id`, `handle`, and `displayName` as JSON. [Sample core](https://github.com/Rust-Inside/sample-rust-core) · [Rust implementation for v0.1.0](https://github.com/Rust-Inside/sample-rust-core/blob/v0.1.0/src/api.rs) · [Spring controller example](https://github.com/Rust-Inside/sample-server-sdk#return-the-signed-in-users-profile)

To try the build, fork `sample-rust-core` and enable GitHub Actions in the fork. In **Actions → Release sample SDKs → Run workflow**, leave `release_tag` blank for a dry run. [Sample workflow](https://github.com/Rust-Inside/sample-rust-core/blob/main/.github/workflows/release.yml)

## Call a Rust server function from Swift

The calculator example defines one server function in Rust. The RPC generator reads its signature and builds the Swift client API and Spring route from it. [Rust source](../examples/swift-spring-rpc/src/api.rs) · [Manifest](../examples/swift-spring-rpc/rust-inside.json)

```rust
#[rust_inside::server]
pub fn add(a: i32, b: i32) -> i64 {
    i64::from(a) + i64::from(b)
}
```

In Swift, create the client once with the server URL. The generated method takes two `Int32` arguments and returns an `Int64`.

```swift
import CalculatorSDK
import Foundation

let calculator = RpcClient(baseURL: serverURL)
let result = try await calculator.add(2, 3) // 5
```

1. The Swift client sends `POST /rpc/add` with `{"a":2,"b":3}`.
2. The generated Spring route reads the arguments and invokes Rust's `add` through the JVM SDK.
3. Spring returns the JSON number `5`, which the Swift client decodes and returns to the caller.

### Run the calculator example

Use Node.js 22+, stable Rust, Python 3.11+, JDK 17+, Gradle 8.11.1, and Swift 6+. Run from the Rust Inside repository root.

```sh
bash examples/swift-spring-rpc/verify.sh
```

The script generates the client and server sources, builds the JVM JAR, and starts Spring on a temporary local port. It runs the Swift client and prints `5`. To keep the generated files, pass an empty output directory.

```sh
bash examples/swift-spring-rpc/verify.sh /tmp/rust-inside-rpc-example
```

In the output directory, `swift/` contains the Swift package, `spring/` contains the Spring project and routes, and `packages/` contains the JVM JAR. To generate the sources without running the example, use the following command.

```sh
node scripts/sdk/generate-rpc.mjs examples/swift-spring-rpc/rust-inside.json /tmp/rust-inside-rpc-sources
```

This local example uses the `api` module and the `jvm` backend. The RPC generator supports server-scoped synchronous functions with `i32`, `i64`, `String`, unit enums, and records with scalar or enum fields. [Verification script](../examples/swift-spring-rpc/verify.sh)

### Submit a report as a signed-in user

The report example defines `report`, `ReportReason`, and `ReportReceipt` in Rust. The generated Swift SDK takes the target and reason. The client already has the demo user's authorization header. [Rust API](../examples/swift-spring-report/src/api.rs) · [Swift caller](../examples/swift-spring-report/swift-example/Sources/RpcExample/main.swift)

```swift
let receipt = try await client.report("post-42", .spam)
print(receipt.reportId)
```

1. Swift sends `POST /rpc/report` with the target and reason. Spring Security authenticates the request.
2. The generated controller creates `RpcContext` from the authenticated principal and a server-generated request ID, then calls Rust through the JVM SDK.
3. Rust builds the typed receipt. A Spring listener saves the report in H2 before the controller returns the receipt to Swift. [Security and storage](../examples/swift-spring-report/spring/src/main/kotlin/dev/rustinside/rpc/ReportConfiguration.kt)

Run from the repository root with the calculator example's tools and `curl`. The script starts Spring on loopback, generates a password for the demo user `martin`, and checks that the returned ID matches the single saved row. It also checks HTTP 401 for an unsigned-in request and HTTP 400 for a request with an extra reporter ID.

```sh
bash examples/swift-spring-report/verify.sh /tmp/rust-inside-report-example
```

Use an empty output directory to keep the generated packages and the `reports.mv.db` database. Run without a path for a temporary workspace.

The report manifest requires `report` on both `ios` and `backend`. Generation checks the Swift SDK and Spring route, and the **Verify report RPC** CI job builds the Swift caller and calls the running Spring server. A Rust function can live anywhere behind the configured API module. An authenticated request to a running server that has no matching route returns HTTP 404. Deploy the new server before updating clients to call the route. [Report contract](../examples/swift-spring-report/rust-inside.json) · [CI workflow](../.github/workflows/check.yml)

## Release an SDK from your Rust repository

1. Declare `pub mod api;` in `src/lib.rs`. Put the SDK functions and client methods in `src/api.rs` and keep helpers private. [Design the API](#design-the-rust-library)
2. Add `rust-inside.json` next to `Cargo.toml`. Set `api` to `src/api.rs` and choose a `backend` and destination repositories. [Manifest example](#connect-your-rust-project)
3. Give each SDK repository an initial commit. Copy the template to `.github/workflows/release.yml` on the core's default branch and run it manually to test the build. [Release setup](#set-up-your-first-multiplatform-release)
4. Set `RUST_INSIDE_RELEASE_TOKEN` with `Contents: Read and write` on the SDK repositories. Push a core tag such as `v0.1.0`, then find that version under **Releases** in each SDK repository. [Installation guides](#install-a-platform-sdk)

The workflow builds from the tagged Rust commit and generates bindings for the public API. It compiles for each configured target, including WebAssembly for the browser. Each release ships the bindings with the prebuilt binary and records the source commit.

<a id="rust-코어-설계하기"></a>

## Design the Rust library

### Start with an optional project layout

Copy the [core template](../templates/core) into a new repository if you want folders for `src/client/`, `src/server/`, and `src/common/`. Add platform-specific client modules when you have code for them. Put the public SDK entry points in `src/api.rs` and keep existing projects organized as they are.

The report sample keeps the receipt and reason types in `src/common/` and the implementation in `src/server/`. Its public API exposes the function for RPC generation. [Report source layout](../examples/swift-spring-report/src)

To show unanswered questions, the app passes all question IDs and the IDs the user has answered. Rust returns the remaining IDs in order. You can move the implementation across modules or crates and keep the same public function.

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

The `api` setting exposes the function declared in your API module, which can call a `pub` function in another crate. A Rust server can use the other crate's public API directly through Cargo.

For synchronous functions in `api` or `exports`, convert `HashMap`, `Option<T>`, and custom errors to supported types. Async client methods can return `Result<Me, String>`. iOS-only projects that already use UniFFI can keep their records and typed errors in Swift. [Supported signatures](#choose-which-platforms-can-call-a-function) · [iOS-only releases](#publish-a-swift-package-for-ios-only)

Check that your library and its dependencies build and run on each target. In browser Wasm, `std::fs` compiles and file reads return an error. Read the file in the app and pass the contents to Rust. Use `#[rust_inside::server]` to expose a server function. Keep OS-specific code behind `cfg`, Cargo target dependencies, or a separate crate. Test shared logic in Rust and platform behavior through the SDK. [Rust Wasm target support](https://doc.rust-lang.org/rustc/platform-support/wasm32-unknown-unknown.html)

<a id="코어-프로젝트-연결"></a>

## Connect your Rust project

Place `rust-inside.json` next to the library's `Cargo.toml`. Point `api` to the module to expose and replace the entries in `repositories` with repositories your team owns. [Sample manifest](https://github.com/Rust-Inside/sample-rust-core/blob/main/rust-inside.json)

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

- `backend` is required. Choose `jvm` for a JAR or `node` for a Node.js npm package. If a Rust server uses the library directly through Cargo, choose `rust` and omit `repositories.backend` or set it to `null`.
- Use `owner/repo` or a GitHub HTTPS URL. Omit the key or set it to `null` to skip a platform. Packages for platforms that share a repository appear in one release.
- A configured platform with no public API emits a warning and skips its package. To make an SDK method mandatory, list its generated name under that platform in `requiredApi`, such as `"requiredApi": {"ios": ["AccountClient.getMe"]}`. Generation fails if a required name is missing. The release workflow and any CI job running the generator enforce this check.
- In a Cargo workspace, use `"crate": "crates/my-core/Cargo.toml"` to select the member. Set `name` to override its Cargo package name.
- For editor completion, copy the schema into your core repository and set `"$schema": "./rust-inside.schema.json"`. [Configuration schema](../rust-inside.schema.json)

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

`apiVersion()` goes to every configured SDK. The `app` attribute exposes `avatarSize()` on iOS, Android, and Flutter. The `web` attribute limits `sharePath(handle)` to the browser.

To use these attributes, add the macro dependency to the library's `Cargo.toml`. Cargo fetches it from the public Rust Inside repository. [Attribute macros](../annotations)

```toml
[dependencies]
rust_inside = { package = "rust-inside-annotations", git = "https://github.com/Rust-Inside/rust-inside.git" }
```

Apply `app`, `ios`, `android`, `flutter`, `web`, or `server` to a function, module, client `impl`, or public trait. Use both `app` and `web` on a declaration to expose it to mobile and web SDKs. For an `exports` entry, set `"platforms": ["app", "web"]`.

For a client, put the public struct, its `pub fn new(...) -> Self` constructor, and its async methods in the same module. The sample's `pub async fn get_me(&self) -> Result<Me, String>` returns a record with public fields. A platform SDK includes the constructor when it exposes at least one client method.

Synchronous function arguments and return values, client method arguments, and record fields support `bool`, 8- to 64-bit integers, `f32`, `f64`, `String`, `Vec<u8>`, `Vec<u32>`, and `Vec<String>`. Synchronous functions can also return `()`.

<a id="ios용-swift-패키지만-배포하기"></a>

### Publish a Swift package for iOS only

The iOS workflow publishes the Swift source and XCFramework at the same tag. For a private SDK repository, SwiftPM needs Git read access.

For an existing UniFFI API, point the manifest to its crate. This example uses a thermometer library.

```json
{
  "backend": "rust",
  "uniffi": { "crate": "mobile-api/Cargo.toml" },
  "repositories": { "ios": "my-team/thermometer-ios-sdk" }
}
```

The crate must produce a `staticlib`. Rust Inside generates Swift bindings with the UniFFI version in the Cargo lockfile, using the crate's configured module name and function signatures. The same workflow also accepts libraries that use `api` or `exports`.

Copy the iOS workflow into the core repository and pin a Rust Inside commit. Create a write-enabled deploy key for the SDK repository and save the private key as `RUST_INSIDE_IOS_PUBLISH_KEY` in the core repository's Actions secrets. The built-in GitHub token reads the public tools. For a private copy of Rust Inside, change the checkout's `repository` and set `RUST_INSIDE_TOOLS_SSH_KEY` to its read key.

Push a `vX.Y.Z` tag to test the core, build and link-check the Swift package, and publish the same tag to the SDK repository. The package includes binaries for iOS 18+ devices and arm64 and x86_64 simulators. [iOS workflow template](../templates/release-ios.yml)

<a id="첫-배포-설정"></a>

## Set up your first multiplatform release

The public workflow can build a private core and publish to private SDK repositories. Consumers need read access to install a private SDK.

Create an initial commit on the default branch of each destination repository.

1. Copy the workflow template to `.github/workflows/release.yml` in the core repository. If the manifest is outside the root directory, set its path with `with.manifest`. [Workflow template](../templates/release.yml)
2. Add the publish token under **Settings → Secrets and variables → Actions** in the core repository. The built-in GitHub token can read the public Rust Inside tools.

| Secret | Repository | Permission |
| --- | --- | --- |
| `RUST_INSIDE_RELEASE_TOKEN` | Destination SDK repositories | `Contents: Read and write` |
| `RUST_INSIDE_TOOLS_TOKEN` (private tools only) | Your private copy of Rust Inside | `Contents: Read` |

If your organization hosts a private copy of Rust Inside, point the caller workflow at that repository and allow access for your private core repository under **Settings → Actions → General → Access**. Public core repositories need a public reusable workflow. [GitHub workflow access rules](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations#access-to-reusable-workflows)

To test packaging with read access only, enter a version under **Actions → Release SDKs → Run workflow**. To publish, push a tag from the core repository.

```sh
git tag v0.1.0
git push origin v0.1.0
```

Rust Inside builds configured platforms with APIs to expose and publishes the same version once all packages are ready. The core repository's Actions summary lists the method names, arguments, and return types. [Release workflow](../.github/workflows/release-sdk.yml)

<a id="nodejs나-rust-서버에서-쓰려면"></a>

## Use the library from a Node.js or Rust server

For Node.js, Rust Inside publishes `<name>-node-<version>.tgz` as CommonJS to `repositories.backend`. The public sample ships a JVM JAR. To try Node.js, copy `sample-rust-core`, set `backend` to `node`, and choose a destination you own such as `your-org/sample-node-sdk`.

Publish a new tag such as `v0.1.1` using the release template. With the sample's manual workflow, enter the new tag in `release_tag` and set `RUST_INSIDE_RELEASE_TOKEN`. Install the published archive in your server project.

```sh
gh release download v0.1.1 --repo your-org/sample-node-sdk \
  --pattern 'sample-rust-core-node-0.1.1.tgz'
npm install ./sample-rust-core-node-0.1.1.tgz
```

```js
const { meResponseJson } = require('sample-rust-core-node');
const body = meResponseJson('u42', 'martin', 'Martin');
```

CI tests the package with Node 22. The package does not specify a minimum Node or npm version.

For a Rust server, pin the library's Git tag in `Cargo.toml`. Cargo builds from source. The library and its dependencies determine the required Rust version.

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

Rust Inside is available under the [MIT License](../LICENSE).
