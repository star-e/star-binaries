# Star Binaries

Build and package third-party C++ dependencies for consumption by star-platforms
and star-engine. This repository does not build Node addons or embed Node/V8 yet.

## Initial targets

| Target | Linkage | Configuration | Requirements |
| --- | --- | --- | --- |
| Windows x64 | DLL, dynamic CRT (/MD in Release, /MDd in Debug) | Release + Debug | Visual Studio C++ tools and Windows SDK |
| macOS arm64 | dylib | Release + Debug | Xcode command-line tools; deployment target macOS 13.0 |

The initial dependency is zlib. Its version is resolved by the pinned vcpkg
baseline. Both configurations are built and tested on every desktop workflow
run. Experimental iOS and Android validation use separate workflows described below.

## Build locally

Install Git and CMake 3.24 or newer, with cmake and ctest on PATH. Run from this
repository:

```sh
git submodule update --init --recursive
```

Windows (PowerShell, using a Visual Studio generator):

```powershell
cmake -DTRIPLET=x64-windows-star -P scripts/build.cmake
```

macOS (use an Apple Silicon host for the native execution test):

```sh
cmake -DTRIPLET=arm64-osx-star -P scripts/build.cmake
```

The same [script](scripts/build.cmake) runs in [GitHub Actions](.github/workflows/build.yml).
It bootstraps the local vcpkg submodule and packages only the target installation,
without the vcpkg executable, host build tools, manuals or general documentation.
Each package has a ZIP and SHA-256 file. The script extracts the archives into a
different directory, checks their contents, and builds/runs the
[consumer tests](tests/consumer/CMakeLists.txt) without a vcpkg toolchain.
Tests verify both SDK consumption and deployment into the extracted runtime
package for each configuration using a zlib compression/decompression round-trip.
The test executable
is installed after archiving and is not included in the published packages.

Outputs are under `out/<triplet>/`:

| ZIP suffix | Contents | Intended consumer |
| --- | --- | --- |
| `-sdk.zip` | Shared headers/metadata, Release libraries in bin/lib, Debug libraries in debug/bin and debug/lib, licenses and provenance | star-platforms / star-engine builds |
| `-release-runtime.zip` | Release dynamic libraries, licenses, metadata and provenance | Application deployment |
| `-debug-runtime.zip` | Debug dynamic libraries, licenses, metadata and provenance | Developer testing |
| `-release-symbols.zip`, `-debug-symbols.zip` | Available PDB/dSYM files for the named configuration, licenses and provenance | Debugging and crash analysis |

The SDK is named `star-binaries-<triplet>-sdk.zip`, replacing the old
`star-binaries-<triplet>-release-sdk.zip` name. Keeping both configurations in one
SDK preserves upstream CMake exports that reference both sets of libraries.
Runtime packages flatten the selected configuration into bin/lib for deployment.
Debug is a separate build, not merely a Release library with a symbol file.

Symbol packages are omitted when the installation provides no separate symbols.
The script does not generate dSYM bundles or strip embedded debug information.
License files may retain their original documentation subdirectory.

CI uploads all ZIPs and checksums only after the tests succeed.
Artifacts are temporary CI outputs. Branch pushes, tag pushes, pull requests and
manual platform builds never create or publish GitHub Releases. No npm package
is published.

Platform workflows build on pushes to `main` and on pull requests. A push to a
development branch does not start a separate build; updating an open PR triggers
its PR checks. Manual platform runs and reusable release calls remain available.

## Publish a release

Create and publish the release yourself on the GitHub website. The
[release workflow](.github/workflows/release.yml) checks every pushed tag and
builds all six targets using the reusable desktop, Android and iOS workflows.
Only a `release: published` event enables the separate asset upload job.

1. Set `version-string` in [vcpkg.json](vcpkg.json) to the intended new version,
   then commit and push the source and workflow changes.
2. Open **Releases > Draft a new release** on GitHub. Select an existing matching
   `vX.Y.Z` tag, or create a new tag on the intended commit using the tag selector.
   Creating a tag on GitHub or pushing it locally starts validation, never publication.
3. Enter the title and release notes, then click **Publish release**.
   Saving a draft alone does not trigger the workflow.
4. Check **Release all platforms** in Actions. Windows, macOS, Android and iOS
   builds must all succeed before packages are uploaded to the release.

The tag must match the manifest version at that commit; prerelease tags are not
supported yet. All targets build the same resolved tag commit. Make sure that
commit includes the release workflow and reusable build workflows.
The asset validation job downloads artifacts from the same workflow run and requires:

- Windows x64 and macOS arm64: SDK and Release/Debug runtime packages.
- Android arm64/x64 and iOS device/simulator arm64: static SDK packages containing
  both Release and Debug libraries.
- SHA-256 files for every package; available desktop symbol packages are included.

To check readiness before publishing, create/push the tag first and wait for
**Release all platforms** to pass: stable tag format, manifest version match,
all six target builds and consumer tests, package completeness and SHA-256 checks.
Every tag push is checked; tags outside the supported `vX.Y.Z` format fail the
version check. These checks run after tag creation and cannot prevent the tag
from being created or disable GitHub's **Publish release** button. Saving a draft
alone is not a trigger, although creating its tag can trigger tag validation.
Publishing later starts a fresh build and validation run before uploading assets.
Tag validation jobs have read-only repository permissions; only the upload job
for a published release receives `contents: write`.

The release becomes visible when you click **Publish release**; binary assets
arrive only after all builds and checksum checks pass. If a build fails, the
release remains published without the complete set of binary assets. The
workflow does not change your release title, notes, or publication state.
Uploading never overwrites same-name assets. If an upload partially fails,
inspect existing assets before recovery; rerunning may encounter filename
conflicts. Never replace already published binaries; publish a new version for
corrections.

This upload-after-publication flow requires releases to allow adding assets
once published; it cannot attach binaries to an immutable release. Repository
rules must also allow the upload job's `GITHUB_TOKEN` to write release assets.
Other jobs retain read-only permissions.

Release URLs supply the version namespace, so asset filenames do not repeat the
version. Downstream consumers should lock the tag, asset filename and SHA-256,
not use a `latest` URL. GitHub settings and permissions, rather than this workflow
alone, determine whether published assets are immutable.

## iOS validation (experimental)

The [iOS workflow](.github/workflows/ios.yml) runs on pushes to `main`, pull requests and
manual dispatches. It builds zlib for two distinct
targets on an Apple Silicon macOS runner with full Xcode:

| Target | Linkage | Deployment target | Validation |
| --- | --- | --- | --- |
| arm64-ios-star | Static | iOS 15.0 | Release and Debug unsigned device App compilation/linking |
| arm64-ios-simulator-star | Static | iOS 15.0 | Release and Debug App execution in an available iPhone simulator |

Run **Actions > Build iOS dependencies > Run workflow**. These targets are
experimental until the Apple build and simulator checks pass. This does not
validate physical devices, App Store acceptance, or execution on iOS 15 itself;
the simulator runtime comes from the selected runner's Xcode installation.
No Apple signing credentials are required for these checks. Device installation
requires a separately signed App and is not part of this workflow.

The [iOS build script](scripts/build-ios.cmake) uses the same pinned vcpkg baseline
as desktop builds but separate [device](triplets/arm64-ios-star.cmake) and
[simulator](triplets/arm64-ios-simulator-star.cmake) triplets. Each SDK ZIP contains
headers, Release libraries in `lib/`, Debug libraries in `debug/lib/`, CMake
exports, licenses and provenance. ZIPs are extracted into a relocated directory
before consumer builds; checksum files are written only after validation passes.
There are no dynamic runtime packages or XCFrameworks in this initial pipeline.
Device and simulator ARM64 libraries are not interchangeable.

The [test App](tests/ios/CMakeLists.txt) reuses the desktop zlib round-trip test.
Simulator execution must emit `STAR_IOS_SMOKE_PASSED` within 120 seconds;
launching the App alone is not considered a passing test. Logs are uploaded even
when validation fails. The workflow uploads SDK artifacts only on success and
is also called by the release workflow, which publishes both iOS SDKs after all
platforms pass validation.

To build locally on an Apple Silicon Mac with full Xcode selected:

```sh
git submodule update --init --recursive
cmake -DTRIPLET=arm64-ios-star -P scripts/build-ios.cmake
xcrun simctl list devices available
xcrun simctl boot <simulator-uuid>
xcrun simctl bootstatus <simulator-uuid> -b
cmake -DTRIPLET=arm64-ios-simulator-star -DSIMULATOR_UDID=<simulator-uuid> -P scripts/build-ios.cmake
xcrun simctl shutdown <simulator-uuid>
```

Skip `simctl boot` if that simulator is already booted. Consume the extracted SDK
with an iOS CMake toolchain and the matching `iphoneos` or `iphonesimulator`
sysroot, then use `find_package(ZLIB CONFIG REQUIRED COMPONENTS static)` and
`ZLIB::ZLIBSTATIC`. For explicit SDK paths outside the sysroot, see the consumer's
`NO_CMAKE_FIND_ROOT_PATH` lookup. This
pipeline adds no V8 dependency and does not modify downstream dependency locks.

## Android validation (experimental)

The [Android workflow](.github/workflows/android.yml) runs on pushes to `main`, pull requests
and manual dispatches using Ubuntu 24.04 and NDK `30.0.16248370` (r30).
It builds the pinned zlib dependency for Android 9 (API 28) or newer:

| Target | ABI | Linkage | Validation |
| --- | --- | --- | --- |
| arm64-android-star | arm64-v8a | Static | Release and Debug native consumer compilation/linking |
| x64-android-star | x86_64 | Static | Release and Debug native consumer execution on an API 28 emulator |

Run **Actions > Build Android dependencies > Run workflow**. These targets remain
experimental until the NDK builds and emulator tests pass. The test executes a
native command-line program through adb; it does not validate APK/AAB packaging,
JNI integration or physical ARM64 device execution in CI.

Install Git, CMake 3.24+, Ninja and the Android NDK. For runtime tests, also install
Android SDK platform-tools and boot a matching emulator or connect a device.
Set `ANDROID_NDK_HOME` to the NDK directory, with `cmake`, `ninja` and `adb` on PATH.
For example, in PowerShell:

```powershell
git submodule update --init --recursive
$env:ANDROID_NDK_HOME = "$env:LOCALAPPDATA/Android/Sdk/ndk/30.0.16248370"
cmake -DTRIPLET=arm64-android-star -P scripts/build-android.cmake
adb devices
cmake -DTRIPLET=x64-android-star -DANDROID_SERIAL=emulator-5554 -P scripts/build-android.cmake
```

The same CMake commands work on Linux and macOS after exporting
`ANDROID_NDK_HOME`. The x64 build requires an explicit device serial and a passing
runtime test. The arm64 build optionally accepts `-DANDROID_SERIAL=<serial>` to
run on a connected ARM64 device. Devices must match the target ABI and run API 28
or newer. Each execution must exit successfully and print
`STAR_ANDROID_SMOKE_PASSED` within 120 seconds.

The [build script](scripts/build-android.cmake) produces
`out/<triplet>/star-binaries-<triplet>-sdk.zip` and its SHA-256 file. Each SDK
contains headers, Release libraries in `lib/`, Debug libraries in `debug/lib/`,
CMake exports, licenses and provenance including the NDK version, ABI and API
level. Consumers compile against a relocated extraction without the vcpkg
toolchain. Checksums and CI artifacts are produced only after validation passes;
runtime logs are uploaded even on test failure. There are no separate runtime
packages or AARs. The release workflow also calls this workflow and publishes
both Android SDKs after all platforms pass validation.

To consume an extracted SDK, configure with the
[NDK CMake toolchain](https://developer.android.com/ndk/guides/cmake), matching
`ANDROID_ABI`, `ANDROID_PLATFORM=android-28`, `ANDROID_STL=c++_static`, and
`CMAKE_BUILD_TYPE=Release` or `Debug`. Set `STAR_SDK_ROOT` to the SDK root:

```cmake
find_package(ZLIB CONFIG REQUIRED COMPONENTS static
  PATHS "${STAR_SDK_ROOT}/share/zlib"
  NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
target_link_libraries(your_target PRIVATE ZLIB::ZLIBSTATIC)
```

See the [Android consumer](tests/android/CMakeLists.txt) for SDK path validation.
Android triplets select static libc++; applications adding C++ dependencies must
keep their STL choice consistent. This pipeline adds no V8 dependency and does
not modify downstream dependency locks.

## Consume a desktop SDK

Verify the ZIP against its SHA-256 file and extract it. Set `CMAKE_PREFIX_PATH`
directly to the extracted SDK root (`star-binaries-<triplet>-sdk`), then use:

```cmake
find_package(ZLIB CONFIG REQUIRED)
target_link_libraries(your_target PRIVATE ZLIB::ZLIB)
```

The config package automatically selects the matching Debug or Release library.
Use `--config Debug` / `--config Release` with multi-config generators, or set
`CMAKE_BUILD_TYPE` with single-config generators. Match the Windows consumer CRT
to the selected configuration. The older module-mode `find_package(ZLIB)` may
not discover the debug subdirectory without additional hints.

On Windows, deploy the zlib DLL beside your executable or provide an explicit
runtime search strategy. On macOS, deploy the dylib and configure install RPATH
for the final application. The runtime smoke test uses `@loader_path/../lib` on
macOS. The runtime package does not bundle the Windows Visual C++ Redistributable
or system libraries; applications must provide their required prerequisites.
Windows Debug packages require the developer's debug CRT installation and are
not intended for end-user redistribution with the normal VC++ Redistributable.
Tests do not cover final application packaging, code signing, or notarization.

Publish these changes under a new release version; do not replace v0.1.0 assets.
Existing star-platforms locks remain unchanged until explicitly upgraded to the
new SDK filename, tag and checksum.

## Versioning and customization

- [tools/vcpkg](tools/vcpkg) is a Git submodule. Update its recorded commit and
  `builtin-baseline` in [vcpkg.json](vcpkg.json) together. Do not use submodule
  `--remote` updates in CI.
- Project-owned [triplets](triplets) select architecture, linkage and configuration.
- Add custom ports and patches to this repository and register overlay ports in
  [vcpkg-configuration.json](vcpkg-configuration.json) when needed. Do not modify
  generated sources or the submodule's official ports for project patches.
- Local vcpkg binary caching uses vcpkg defaults/environment configuration. CI
  currently has no persistent cross-job binary cache; that can be added when the
  dependency set grows.
- SDK packages include target-package metadata and dependency license files.
  `provenance/` also contains the manifest, triplets and source/tool revisions.
  Uncommitted local changes are not represented by the source commit alone.
- Hosted runner images and compilers are not immutable. CI logs record the actual
  compiler selected by vcpkg and the consumer; these initial packages are not a
  promise of bit-for-bit reproducibility or minimum-OS runtime certification.

For historical fixes, branch from the affected release tag, retain the original
dependency baseline, add the patch, and publish a new package revision rather
than replacing an existing release artifact.
