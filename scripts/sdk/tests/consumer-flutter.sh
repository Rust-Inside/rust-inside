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
node --input-type=module - "$generated/sdk.json" >> lib/main.dart <<'NODE'
import { readFileSync } from 'node:fs';

const sdk = JSON.parse(readFileSync(process.argv[2], 'utf8'));
for (const [index, name] of (sdk.requiredApi?.flutter ?? []).entries()) {
  const [symbol, method] = name.split('.');
  const signature = method ? `api.${symbol} client` : '';
  const reference = method ? `client.${method}` : `api.${symbol}`;
  console.log(`Object checkRequiredApi${index}(${signature}) => ${reference};`);
}
NODE

# Give Maven Central time to recover after Flutter's own immediate retry.
build_log="$stage/flutter-build.log"
for retry_delay in 20 40 0; do
  if flutter build apk --debug 2>&1 | tee "$build_log"; then
    break
  else
    build_status=("${PIPESTATUS[@]}")
  fi
  if (( build_status[1] != 0 )); then
    exit "${build_status[1]}"
  fi
  if (( retry_delay == 0 )) || ! grep -Eq \
    'https?://(repo\.maven\.apache\.org|repo1\.maven\.org)/maven2/[^[:space:]]+[[:space:]].*Received status code 429([[:space:]]|$)' "$build_log"; then
    exit "${build_status[0]}"
  fi
  printf 'Maven Central rate limited the Flutter APK build. Retrying in %s seconds.\n' "$retry_delay" >&2
  sleep "$retry_delay"
done

apk=build/app/outputs/flutter-apk/app-debug.apk
for abi in armeabi-v7a arm64-v8a x86_64; do
  unzip -tqq "$apk" "lib/$abi/lib$name.so"
done
