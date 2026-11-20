#!/usr/bin/env bash
set -euo pipefail

templates="$(cd "$(dirname "$0")/package-templates/android" && pwd)"
workspace="${1:?Pass the generated workspace}"
version="${2:?Pass the SDK version}"
mkdir -p "${3:?Pass the output directory}"
output="$(cd "$3" && pwd)"
workspace="$(cd "$workspace" && pwd)"
if [[ -d "$workspace/platforms/android" ]]; then workspace="$workspace/platforms/android"; fi
mobile="$workspace/mobile"
library="$(node -p 'require(process.argv[1]).library' "$workspace/sdk.json")"
namespace="$(node -p 'require(process.argv[1]).kotlinPackage' "$workspace/sdk.json")"
artifact="$(node -p 'require(process.argv[1]).name' "$workspace/sdk.json")-android"
coroutines_version="$(node -p 'require(process.argv[1]).kotlinCoroutinesVersion || ""' "$workspace/sdk.json")"
mkdir -p "${CARGO_TARGET_DIR:=$workspace/target}"
export CARGO_TARGET_DIR="$(cd "$CARGO_TARGET_DIR" && pwd)"
ndk="${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to the Android NDK directory}"
case "$(uname -s)" in
  Darwin) host=darwin-x86_64 ;;
  Linux) host=linux-x86_64 ;;
  *) echo "Use an Apple or Linux NDK host" >&2; exit 1 ;;
esac
toolchain="$ndk/toolchains/llvm/prebuilt/$host/bin"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

host_target="$(rustc --print host-tuple)"
cargo build --manifest-path "$mobile/Cargo.toml" --locked --no-default-features --target "$host_target" \
  --features bindgen --bin rust-inside-bindgen
for abi in arm64-v8a x86_64; do
  target=x86_64-linux-android
  linker_env=CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER
  if [[ "$abi" == arm64-v8a ]]; then
    target=aarch64-linux-android
    linker_env=CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
  fi
  env "$linker_env=$toolchain/${target}23-clang" \
    "CC_${target//-/_}=$toolchain/${target}23-clang" \
    "CXX_${target//-/_}=$toolchain/${target}23-clang++" "AR_${target//-/_}=$toolchain/llvm-ar" \
    cargo build --manifest-path "$mobile/Cargo.toml" --locked --release --no-default-features --lib --target "$target"
  mkdir -p "$stage/jniLibs/$abi"
  cp "$CARGO_TARGET_DIR/$target/release/lib$library.so" "$stage/jniLibs/$abi/"
done

(
  cd "$mobile"
  "$CARGO_TARGET_DIR/$host_target/debug/rust-inside-bindgen" generate --metadata-no-deps --crate "$library" \
    "$stage/jniLibs/arm64-v8a/lib$library.so" --language kotlin --no-format --out-dir "$stage/kotlin"
)
project="$stage/gradle"
mkdir -p "$project"
cp -R "$templates/src" "$templates/build.gradle" "$templates/settings.gradle" "$project/"
sed "s/dev\.rustinside\.sdk/$namespace/g" "$templates/consumer-rules.pro" > "$project/consumer-rules.pro"
if [[ -f "$workspace/LICENSE" ]]; then
  mkdir -p "$project/src/main/assets/$artifact"
  cp "$workspace/LICENSE" "$project/src/main/assets/$artifact/LICENSE"
fi
gradle --no-daemon -p "$project" -PsdkInputs="$stage" -PsdkNamespace="$namespace" \
  -PsdkCoroutinesVersion="$coroutines_version" :assembleRelease

aar="$project/build/outputs/aar/rust-inside-android-release.aar"
for abi in arm64-v8a x86_64; do
  unzip -t "$aar" "jni/$abi/lib$library.so"
done
unzip -p "$aar" classes.jar > "$stage/classes.jar"
unzip -t "$stage/classes.jar" "${namespace//./\/}/*.class" > /dev/null
cp "$aar" "$output/$artifact-$version.aar"
coroutines_dependency=''
if [[ -n "$coroutines_version" ]]; then
  coroutines_dependency="<dependency org=\"org.jetbrains.kotlinx\" name=\"kotlinx-coroutines-core-jvm\" rev=\"$coroutines_version\" conf=\"default->default\" />"
fi
sed -e "s|@COROUTINES_DEPENDENCY@|$coroutines_dependency|" \
  -e "s/@GROUP@/$namespace/g" -e "s/@ARTIFACT@/$artifact/g" -e "s/@VERSION@/$version/g" \
  "$templates/ivy.xml" > "$output/$artifact-$version.xml"
