#!/usr/bin/env bash
set -euo pipefail

generated="$(cd "${1:?Pass the generated Flutter workspace}" && pwd)"
package="$(cd "${2:?Pass the prebuilt Flutter package}" && pwd)"
version="${3:?Pass the release version}"
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT

# Use the same tagged Git layout that Pub will install from the destination.
mkdir -p "$stage/repository"
cp -R "$package" "$stage/repository/flutter"
git -C "$stage/repository" init --quiet
git -C "$stage/repository" add flutter
git -C "$stage/repository" -c user.name=CI -c user.email=ci@example.invalid -c commit.gpgsign=false commit -qm 'Package for consumer test'
git -C "$stage/repository" -c tag.gpgsign=false tag "v$version"
(
  cd "$stage/repository/flutter"
  flutter pub get
  flutter analyze --no-pub
)
flutter create --no-pub --platforms android --empty --project-name package_check "$stage/consumer"
cd "$stage/consumer"
read -r name symbol < <(node -p 'const s = require(process.argv[1]); [s.name.replaceAll("-", "_") + "_flutter", s.exports[0]?.jsName ?? s.clients[0].name].join(" ")' "$generated/sdk.json")
git_url="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$stage/repository")"
cat > pubspec.yaml <<YAML
name: package_check
environment:
  sdk: '>=3.10.0 <4.0.0'
dependencies:
  flutter:
    sdk: flutter
  $name:
    git:
      url: "$git_url"
      ref: v$version
      path: flutter
YAML
flutter pub get
cat > lib/main.dart <<DART
import 'package:flutter/widgets.dart';
import 'package:$name/$name.dart' as api;

void main() {
  final symbol = api.$symbol;
  runApp(Directionality(textDirection: TextDirection.ltr, child: Text(symbol.toString())));
}
DART
flutter build apk --debug
apk=build/app/outputs/flutter-apk/app-debug.apk
for abi in armeabi-v7a arm64-v8a x86_64; do
  unzip -tqq "$apk" "lib/$abi/lib$name.so"
done
