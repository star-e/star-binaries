#!/usr/bin/env bash
set -euo pipefail

source_dir="$1"
version_suffix="$2"
revision="$3"
subsets="$4"
jobs="$5"

[[ "$(uname -s)" == Darwin && "$(uname -m)" == arm64 ]] || {
  echo 'CoreCLR macOS build requires a native arm64 host' >&2
  exit 1
}
for tool in cmake ninja python3 git pkg-config; do
  command -v "$tool" >/dev/null
done
xcrun --find clang
export CMAKE_BUILD_PARALLEL_LEVEL="$jobs"
export DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
export DOTNET_GENERATE_ASPNET_CERTIFICATE=false
export DOTNET_ADD_GLOBAL_TOOLS_TO_PATH=false
cd "$source_dir"
exec ./build.sh -subset "$subsets" -configuration Release -arch arm64 -os osx -ci \
  /p:VersionSuffix="$version_suffix" /p:GenerateInstallers=false \
  /p:GenerateVSInsertionPackages=false /p:SkipInstallerBuild=true \
  /p:IncludeSourceRevisionInInformationalVersion=true /p:SourceRevisionId="$revision" \
  /maxcpucount:"$jobs"
