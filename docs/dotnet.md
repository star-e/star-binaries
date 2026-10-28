# CoreCLR SDK

Native C++ applications host .NET directly. This package contains CoreCLR,
CoreLib, the base class libraries and native hosting components, without MAUI.
Build targets are **Windows x64** and **macOS arm64**, both Release. Windows has
been exercised locally; macOS execution is validated by its hosted CI job.
Mobile hosts and engine/codegen integration are subsequent work.

The experimental [base runtime profile](dotnet-base.md) packages a smaller library
selection from an existing SDK. CI validates and uploads both full and base SDKs.

[dotnet-version.cmake](../dotnet-version.cmake) pins upstream
`v11.0.0-rc.3.26522.148` and its full commit. Our unsigned source build uses
`11.0.0-star.rc3.26522.148` to distinguish it from Microsoft's release binaries.
The runtime build bootstraps the SDK in upstream `global.json`; the consumer
compiler is separately pinned to .NET SDK `11.0.100-rc.3.26522.148`, downloaded
with its official SHA-512. Neither SDK is shipped inside the runtime package.

The pinned upstream restore currently reports NU1902 for
`Microsoft.Native.Quic.MsQuic.Schannel` 2.5.10
([advisory](https://github.com/advisories/GHSA-2mxg-prvg-9jfg)). This pipeline
preserves upstream dependency versions; the hosting smoke test does not exercise QUIC.

## Build and verify

Windows needs Visual Studio C++ x64 tools, a Windows SDK, CMake 3.26+, Ninja and
Python 3.7.4+. Enable Windows long paths; the script initializes the VS developer
environment and configures long-path support in its own Git checkout.
macOS needs an arm64 host, Xcode command-line tools, CMake 3.26+, Ninja, Python 3,
pkg-config and icu4c (`brew install cmake ninja pkg-config icu4c`).
Both need Git, access to GitHub and Microsoft's SDK/NuGet feeds, and tens of GB
of disk space. Intel macOS/Rosetta builds are rejected.

From the repository root:

```powershell
cmake -DTRIPLET=x64-windows-star -DJOBS=4 -P scripts/build-dotnet.cmake
# Inspect the selected source and build arguments without downloading:
cmake -DPRINT_ARGS=ON -P scripts/build-dotnet.cmake
```

On macOS arm64:

```sh
cmake -DTRIPLET=arm64-osx-star -DJOBS=2 -P scripts/build-dotnet.cmake
```

The script fetches a clean pinned checkout under `out/dotnet/source`, builds
CoreCLR/CoreLib/libraries/host/packs, and packages the upstream runtime archive with
hosting headers and nethost. Build output is in `out/dotnet/source-build.log`;
upstream detailed logs remain under `source/artifacts/log/Release`.
Reruns use upstream incremental builds, checking the source revision and local
changes first. Changing the pin requires a fresh build checkout.

Before publishing an archive locally, the script extracts it into a path
containing spaces, verifies every payload SHA-256, and builds/runs the consumer:

- C++ starts the selected runtime and calls a C# entry point.
- C# calls a native function pointer, exercises allocation/GC, and checks the
  loaded CoreLib location, version and source revision.
- C++ checks the actual hostfxr, CoreCLR, JIT and hostpolicy module paths.
- Requesting a missing framework with roll-forward disabled must fail without
  loading CoreCLR. A successful test requires the expected marker and exit code.

The final archive and SHA-256 sidecar are under:

```text
out/dotnet/x64-windows-star/Release/
  star-dotnet-11.0.0-rc.3.26522.148-x64-windows-star-release-sdk.zip
out/dotnet/arm64-osx-star/Release/
  star-dotnet-11.0.0-rc.3.26522.148-arm64-osx-star-release-sdk.tar.gz
```

Staging directories retain the extracted package, consumer build and test logs.
An unsuccessful run does not replace an earlier validated archive. macOS uses
`tar.gz` to preserve executable permissions.

## GitHub Actions

[CoreCLR SDK](../.github/workflows/dotnet.yml) combines building, packaging and
validation for Windows x64 and macOS arm64. It runs on `main` pushes affecting the
version pin, .NET scripts/tests or this workflow. Documentation-only changes do
not trigger it. Manual **Run workflow** needs no run ID or operation selection;
`force_rebuild` optionally bypasses the cache.

1. Restore a full SDK archive keyed by target, the version pin and full-build
   scripts. No match (including an evicted cache) means build from pinned source.
2. Verify the archive checksum, package provenance and payload checksums, then
   run the current consumer from a relocated directory. Cache hits are always
   revalidated; a corrupt/incompatible cache fails instead of silently rebuilding.
3. Cache a newly built full SDK only after validation, then generate and validate
   the base SDK using the current profile. Changing only the profile or tests
   reuses the full SDK.

Uploads are `dotnet-<triplet>-Release-sdk`,
`dotnet-<triplet>-Release-base-sdk` and `dotnet-<triplet>-Release-logs`.
Each SDK is uploaded after its checks pass; the full SDK remains available if
base packaging fails. Logs and validation receipts are uploaded even on failure.
Only archives and checksums are cached, not the large source/build tree.
Existing artifacts from the old manual workflow do not seed this cache.

Jobs are limited to 180 minutes; cached-SDK validation and base packaging each
have a 30-minute step limit. New pushes queue behind an active build for the
same branch/target instead of canceling it. The workflow does not publish releases.
For independently downloaded archives, use the validation commands below.
The macOS job must pass on an actual arm64 runner before treating that package
as validated; Windows checks and `PRINT_ARGS` do not establish macOS support.

## Package and consume

```text
include/              nethost.h, hostfxr.h, coreclr_delegates.h, host_error_codes.h
bin/                  nethost.dll or libnethost.dylib
lib/                  nethost.lib (Windows import lib) or libnethost.a (macOS static lib)
runtime/              upstream dotnet runtime layout, including host/fxr and shared
share/dotnet/         relocatable StarDotNetConfig.cmake
provenance/           source/build identity, upstream global.json, payload checksums
LICENSE.TXT
THIRD-PARTY-NOTICES.TXT
```

Deploy the complete `runtime/` directory and nethost, preserving the runtime
layout. `StarDotNet::Hosting` supplies headers for applications which dynamically
load hosting functions, as the [consumer](../tests/dotnet/main.cpp) does:

```cmake
find_package(StarDotNet CONFIG REQUIRED
  PATHS "${STAR_SDK_ROOT}/share/dotnet" NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
target_link_libraries(your_host PRIVATE StarDotNet::Hosting)
```

Explicitly pass the packaged root to both `get_hostfxr_path` and
`hostfxr_initialize_for_runtime_config`. Use the exact
`StarDotNet_RUNTIME_VERSION` in the component's `.runtimeconfig.json` and disable
roll-forward. This uses a private runtime root with framework-dependent managed
components; it does not require installing that runtime globally.
`hostfxr_close` releases the host context, not the process-wide CLR. The smoke
test exits the process after its synchronous work; it does not claim CLR unload
or engine-session lifetime coverage.

Validate a downloaded archive with its adjacent `.sha256` file:

```powershell
cmake "-DARCHIVE=D:/SDKs/star-dotnet-11.0.0-rc.3.26522.148-x64-windows-star-release-sdk.zip" -P scripts/dotnet/validate-archive.cmake
```

On macOS use the `.tar.gz` path and `-DTRIPLET=arm64-osx-star` (also the macOS
default). Validation requires a native host matching the package. Each archive
check extracts to a fresh path containing spaces and writes `validated.json`
only after both runtime tests pass.

Validate an already extracted package:

```powershell
cmake "-DSTAR_SDK_ROOT=D:/SDKs/star-dotnet-11.0.0-rc.3.26522.148-x64-windows-star-release-sdk" -P scripts/dotnet/validate.cmake
```

This downloads the pinned consumer SDK if needed. `DOTNET_EXECUTABLE` can name
an existing copy of that exact SDK; `BUILD_DIR` selects a consumer build directory.
The managed test has no external NuGet dependencies.

Upstream references: [release](https://github.com/dotnet/runtime/releases/tag/v11.0.0-rc.3.26522.148),
[Windows requirements](https://github.com/dotnet/runtime/blob/v11.0.0-rc.3.26522.148/docs/workflow/requirements/windows-requirements.md),
[macOS requirements](https://github.com/dotnet/runtime/blob/v11.0.0-rc.3.26522.148/docs/workflow/requirements/macos-requirements.md),
[SDK checksums](https://builds.dotnet.microsoft.com/dotnet/release-metadata/11.0/releases.json),
[native hosting](https://learn.microsoft.com/en-us/dotnet/core/tutorials/netcore-hosting).
