#!/usr/bin/env bash
set -euo pipefail

source_dir="$1"
target_os="$2"
ndk_version="$3"
jobs="$4"
shift 4

for tool in cmake ninja python3 git; do
  command -v "$tool" >/dev/null
done
case "$target_os" in
  android)
    [[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
      echo 'Android CoreCLR builds require Linux x64 (WSL2 is also supported)' >&2
      exit 1
    }
    : "${ANDROID_SDK_ROOT:?Set ANDROID_SDK_ROOT}"
    : "${ANDROID_NDK_ROOT:?Set ANDROID_NDK_ROOT}"
    [[ -d "$ANDROID_SDK_ROOT" ]]
    actual_ndk=$(sed -n 's/^Pkg.Revision *= *//p' "$ANDROID_NDK_ROOT/source.properties" | tr -d '\r')
    [[ "$actual_ndk" == "$ndk_version" ]] || {
      echo "Expected Android NDK $ndk_version, found $actual_ndk" >&2
      exit 1
    }
    java -version
    "$ANDROID_NDK_ROOT/toolchains/llvm/prebuilt/linux-x86_64/bin/clang" --version
    ;;
  ios|iossimulator)
    [[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
      echo 'iOS CoreCLR builds require native macOS arm64 with full Xcode' >&2
      exit 1
    }
    sdk=iphoneos
    [[ "$target_os" != iossimulator ]] || sdk=iphonesimulator
    xcodebuild -version
    xcrun --sdk "$sdk" --show-sdk-version
    xcrun --sdk "$sdk" --find clang
    ;;
  *) echo "Unsupported mobile OS: $target_os" >&2; exit 1 ;;
esac

export CMAKE_BUILD_PARALLEL_LEVEL="$jobs"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
export DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false
cd "$source_dir"
printf 'Building pinned CoreCLR: ./build.sh'
printf ' %q' "$@"
printf '\n'
exec ./build.sh "$@"
