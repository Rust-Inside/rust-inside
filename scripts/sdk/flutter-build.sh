#!/usr/bin/env bash
set -euo pipefail

workspace="$(cd "${1:?Pass the generated Flutter workspace}" && pwd)"
platform="${2:?Pass ios or android}"
mkdir -p "${3:?Pass the native output directory}"
output="$(cd "$3" && pwd)"
read -r name library < <(node -p 'const s=require(process.argv[1]); [s.name,s.flutterLibrary].join(" ")' "$workspace/sdk.json")
mkdir -p "${CARGO_TARGET_DIR:=$workspace/target}"
export CARGO_TARGET_DIR="$(cd "$CARGO_TARGET_DIR" && pwd)"
manifest="$workspace/flutter/Cargo.toml"

case "$platform" in
  ios)
    export IPHONEOS_DEPLOYMENT_TARGET=18.0
    for pair in aarch64-apple-ios:ios-arm64 aarch64-apple-ios-sim:ios-sim-arm64 x86_64-apple-ios:ios-sim-x64; do
      target="${pair%:*}"
      cargo build --locked --lib --release --manifest-path "$manifest" --target "$target"
      cp "$CARGO_TARGET_DIR/$target/release/lib$library.dylib" "$output/$name-${pair#*:}.dylib"
    done
    ;;
  android)
    ndk="${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to the Android NDK directory}"
    case "$(uname -s)" in
      Darwin) host=darwin-x86_64 ;;
      Linux) host=linux-x86_64 ;;
      *) echo "Use a macOS or Linux NDK host" >&2; exit 1 ;;
    esac
    bin="$ndk/toolchains/llvm/prebuilt/$host/bin"
    for pair in armv7-linux-androideabi:android-arm aarch64-linux-android:android-arm64 x86_64-linux-android:android-x64; do
      target="${pair%:*}"
      triple="$target"
      case "$target" in
        armv7-linux-androideabi) linker=CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER; triple=armv7a-linux-androideabi ;;
        aarch64-linux-android) linker=CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER ;;
        x86_64-linux-android) linker=CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER ;;
      esac
      env "$linker=$bin/${triple}23-clang" \
        "CC_${target//-/_}=$bin/${triple}23-clang" "CXX_${target//-/_}=$bin/${triple}23-clang++" \
        "AR_${target//-/_}=$bin/llvm-ar" cargo build --locked --lib --release --manifest-path "$manifest" --target "$target"
      cp "$CARGO_TARGET_DIR/$target/release/lib$library.so" "$output/$name-${pair#*:}.so"
    done
    ;;
  *) echo "Unknown Flutter mobile platform: $platform" >&2; exit 1 ;;
esac
