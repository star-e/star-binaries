# CoreCLR SDK

Native C++ applications host .NET directly. This package contains CoreCLR,
CoreLib, the base class libraries and native hosting components, without MAUI.
Desktop SDK targets are **Windows x64** and **macOS arm64**, both Release, with
packaged-runtime execution checks. Mobile build jobs target **Android arm64/x64**
and **iOS device/simulator arm64**; they check runtime packs without executing them.
The mobile build scripts still need their first hosted CI result. Mobile hosts
and engine/codegen integration follow compilation and packaging.

Build and Release distribute complete runtimes: full desktop SDKs and intact
mobile runtime packs. Engine development and preview use these complete inputs;
library selection and trimming belong to the final application/game publish step.
The experimental [base runtime profile](dotnet-base.md) remains a manual tool for
that work; CI does not generate or publish base SDKs.

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

## Editing C#

VS Code needs a .NET SDK for C# project loading; a runtime alone is insufficient.
Visual Studio's C# workload is not required for this workflow.
[global.json](../global.json) selects the pinned compiler SDK from
`out/dotnet/tools` (downloaded by package validation), then from the invoking
`dotnet` installation. Keep its version and paths aligned with
`STAR_DOTNET_SDK_VERSION` in `dotnet-version.cmake` when updating the pin.
The [SDK paths setting](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json#paths)
requires a .NET 10+ host. A fresh checkout needs either package validation to
acquire the local SDK or a separately installed matching SDK.

Open [StarDotNet.slnx](../StarDotNet.slnx) in C# Dev Kit; it contains only our
four managed projects, excluding the downloaded runtime source under `out/`.
The repository VS Code settings select it by default. In a multi-root workspace,
use **.NET: Open Solution** if it is not selected automatically. After changing
SDK configuration, run **Developer: Reload Window**. Check resolution from the
repository directory with `dotnet --version`.

## Build and verify

Windows needs Visual Studio C++ x64 tools, a Windows SDK, CMake 3.26+, Ninja and
Python 3.7.4+. Enable Windows long paths; the script initializes the VS developer
environment and configures long-path support in its own Git checkout.
The source-build child initializes x64 MSVC once and sets upstream
`SkipVCEnvInit=1`, avoiding repeated `vcvarsall.bat` PATH expansion. Package
validation uses CMake's Visual Studio generator without a developer shell.
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

## Android and iOS builds

The same build entry selects a mobile pipeline by triplet:

| Triplet | Build host | Execution model |
| --- | --- | --- |
| `arm64-android-star` | Linux x64 | CoreCLR JIT + ReadyToRun |
| `x64-android-star` | Linux x64 | CoreCLR JIT + ReadyToRun |
| `arm64-ios-star` | macOS arm64, full Xcode | CoreCLR interpreter + ReadyToRun |
| `arm64-ios-simulator-star` | macOS arm64, full Xcode | CoreCLR interpreter + ReadyToRun |

Android uses **NDK r27c (`27.2.12479018`)**, independently of the V8/vcpkg NDK.
Install the pinned NDK, Android SDK/platform 24 and OpenJDK 23 (Ubuntu OpenJDK 21
also works upstream). Set `ANDROID_SDK_ROOT` and `ANDROID_NDK_ROOT`; the build
rejects a mismatched NDK. The pinned runtime sets minimum native API 24.
Linux also needs the upstream native dependencies installed in the workflow.
Windows can build through a Linux checkout in WSL2, not the Windows build entry.
For iOS, install the macOS dependencies above and full Xcode with the iPhoneOS
and iPhoneSimulator SDKs. No MAUI workload is installed.

```sh
# On Linux x64, with the Android environment prepared:
cmake -DTRIPLET=arm64-android-star -DJOBS=4 -P scripts/build-dotnet.cmake
cmake -DTRIPLET=x64-android-star -DJOBS=4 -P scripts/build-dotnet.cmake
# On macOS arm64:
cmake -DTRIPLET=arm64-ios-star -DJOBS=2 -P scripts/build-dotnet.cmake
cmake -DTRIPLET=arm64-ios-simulator-star -DJOBS=2 -P scripts/build-dotnet.cmake
```

`-DPRINT_ARGS=ON` works on any host without downloading or compiling. Builds use
the same clean source pin and lock as desktop; run local targets sequentially.
iOS explicitly enables the interpreter and disables JIT; the upstream pack
build produces the Mach-O composite ReadyToRun image. This remains CoreCLR.
The composite `.r2r.dylib` may be under `runtimes/<rid>/lib/net11.0/` beside
CoreLib or under `native/`; both locations receive native architecture/platform checks.

Outputs under `out/dotnet/<triplet>/Release/` are
`star-dotnet-<version>-<triplet>-release-runtime-pack.tar.gz` and `.sha256`.
Each archive contains the unchanged `Microsoft.NETCore.App.Runtime.<rid>` NuGet
package, CoreCLR hosting headers, licenses, source/build provenance and file hashes.
Checks cover NuGet ID/version/RID, CoreLib, native CPU architecture, Apple device
versus simulator platform, Android JIT, Apple R2R, and archive relocation.
`provenance/build.json` records `runtimeTested: false`.

These are runtime packs, not the desktop `hostfxr` SDK layout. They are not passed
to `package-dotnet.cmake`, `validate-archive.cmake` or `StarDotNet::Hosting`.
The desktop base profile is not applied: all upstream libraries and the Apple
composite R2R image remain intact. Static-link archives from inner build outputs
are not added to this package. These packs can be published as experimental
build-checked inputs. Mobile embedding, application packaging/signing, and
simulator/device execution are subsequent consumer work.

Local orchestration/package-format tests (fixtures, not mobile execution):
`python3 tests/dotnet/mobile.test.py`.
Build commands follow the pinned upstream
[Android](https://github.com/dotnet/runtime/blob/v11.0.0-rc.3.26522.148/docs/workflow/building/coreclr/android.md)
and [iOS](https://github.com/dotnet/runtime/blob/v11.0.0-rc.3.26522.148/docs/workflow/building/coreclr/ios.md)
instructions.

## GitHub Actions

[Build .NET](../.github/workflows/dotnet.yml) combines building, packaging and
validation for Windows/macOS, plus four mobile runtime-pack builds. Start it with
**Run workflow**; pushes and pull requests do not trigger builds.
`force_rebuild` optionally bypasses the cache.

1. Restore a full SDK archive keyed by target, the version pin and full-build
   scripts. No match (including an evicted cache) means build from pinned source.
2. Verify the archive checksum, package provenance and payload checksums, then
   run the current consumer from a relocated directory. Cache hits are always
   revalidated; a corrupt/incompatible cache fails instead of silently rebuilding.
3. Cache a newly built full SDK only after validation, then upload the full SDK.

Uploads are `dotnet-<triplet>-Release-sdk` and `dotnet-<triplet>-Release-logs`.
Each SDK is uploaded after its checks pass. Logs and validation receipts are
uploaded even on failure.
Only archives and checksums are cached, not the large source/build tree.
Existing artifacts from the old manual workflow do not seed this cache.

Desktop jobs are limited to 180 minutes; cached-SDK validation has a 30-minute
step limit. Mobile jobs are limited to **240 minutes** each
and currently build from source every run, uploading
`dotnet-<triplet>-Release-runtime-pack` and diagnostic logs. `force_rebuild` affects
only desktop SDK caching. Manual runs queue behind an active build for the
same branch/target instead of canceling it. The workflow does not publish releases.
For independently downloaded archives, use the validation commands below.
The macOS job must pass on an actual arm64 runner before treating that package
as validated; Windows checks and `PRINT_ARGS` do not establish macOS support.

## Release binaries

[Release](../.github/workflows/release.yml) collects the existing six packages
without rebuilding CoreCLR. Configure `dotnet` in
[release-inputs.json](../release-inputs.json): `workflow` with `runId: "latest"`
selects a complete compatible Build .NET run on `main`; a numeric run ID fixes
one run, and `release` with a previous tag reuses published archives.

The release includes Windows/macOS full SDKs, four mobile runtime packs,
SHA-256 sidecars and `dotnet-provenance.json`. It records exact source run/commit,
upstream revision and per-package `runtimeTested`: desktop `true`, mobile `false`.
The distribution remains experimental. See the [release guide](release.md) for
source selection, retries and publication. Workflow changes affect the source
fingerprint: run Build .NET once after changing its workflow. Existing
matching desktop SDK caches can still avoid source compilation.

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
