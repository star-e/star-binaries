# Dependency SDKs

The [manifest](../vcpkg.json) selects zlib, Boost.Container, Boost.Unordered,
Boost.DynamicBitset and stdexec. Versions come from its pinned baseline and
the [stdexec overlay](../ports/stdexec/README.md). V8 is built and
packaged separately; see [V8 SDKs](v8.md).

## Targets and validation

All targets build Release and Debug. Tests consume a relocated SDK without a
vcpkg toolchain and check zlib round-trips, Boost containers, compiled PMR symbols,
and stdexec sender composition, coroutine results, errors, stopping and thread scheduling.

| Triplet | Toolchain / target | Linkage | CI validation |
| --- | --- | --- | --- |
| x64-windows-star | Visual Studio C++ tools and Windows SDK | DLL, /MD or /MDd CRT | Execute both configurations |
| arm64-osx-star | Apple Silicon, Xcode tools; macOS 13.0 | dylib | Execute both configurations |
| arm64-android-star | NDK 30.0.16248370; API 28, arm64-v8a | Static, c++_static | Compile/link |
| x64-android-star | Same NDK/API; x86_64 | Static, c++_static | Execute on API 28 emulator |
| arm64-ios-star | Apple Silicon, full Xcode; iOS 15.0 | Static | Compile/link unsigned App |
| arm64-ios-simulator-star | Same Xcode/target; iphonesimulator | Static | Execute App in available simulator |

Deployment targets are build settings, not proof of execution on the oldest OS.
stdexec is header-only on all targets; the linkage column applies to compiled libraries.
CI does not cover physical ARM64 mobile devices, signing, App Store submission,
APK/AAB packaging or JNI integration. Device and simulator libraries are distinct.

## Build locally

Install Git, CMake 3.24+ and the target toolchain; put `cmake` and `ctest` on PATH.
Run all commands from the repository root:

```sh
git submodule update --init --recursive
```

### Windows and macOS

Run the command for the current host:

```sh
cmake -DTRIPLET=x64-windows-star -P scripts/build.cmake
cmake -DTRIPLET=arm64-osx-star -P scripts/build.cmake
```

The [desktop script](../scripts/build.cmake) bootstraps vcpkg, packages the target
installation, then tests SDK consumption and runtime deployment. Test executables
are not included in the published packages.

### Android

Install Ninja and set `ANDROID_NDK_HOME`. Runtime tests additionally need
platform-tools (`adb`) and a matching emulator/device. PowerShell example:

```powershell
$env:ANDROID_NDK_HOME = "$env:LOCALAPPDATA/Android/Sdk/ndk/30.0.16248370"
cmake -DTRIPLET=arm64-android-star -P scripts/build-android.cmake
adb devices
cmake -DTRIPLET=x64-android-star -DANDROID_SERIAL=emulator-5554 -P scripts/build-android.cmake
```

The same CMake commands work on Linux/macOS with the equivalent environment
variable. x64 requires a device serial; arm64 optionally accepts one. The device
must match the ABI and API 28+, and the consumer must exit successfully with
`STAR_ANDROID_SMOKE_PASSED` within 120 seconds.

### iOS

Use an Apple Silicon Mac with full Xcode selected:

```sh
cmake -DTRIPLET=arm64-ios-star -P scripts/build-ios.cmake
xcrun simctl list devices available
xcrun simctl bootstatus <uuid> -b
cmake -DTRIPLET=arm64-ios-simulator-star -DSIMULATOR_UDID=<uuid> -P scripts/build-ios.cmake
xcrun simctl shutdown <uuid>
```

The ordinary iOS script expects a booted simulator; its CI workflow starts one
before building. No signing credentials are needed for these checks.
See [simulator troubleshooting](v8-release.md#failures-and-retries) for timeouts
and logs.

## Package layout

Outputs are in `out/<triplet>/`, named `star-binaries-<triplet>-<suffix>.zip`
with matching `.zip.sha256` files.

| Suffix | Contents |
| --- | --- |
| sdk | Headers, CMake exports, Release libraries, Debug libraries under debug/, licenses and provenance |
| release-runtime / debug-runtime | Desktop dynamic libraries for the selected configuration |
| release-symbols / debug-symbols | Available desktop PDB/dSYM files; omitted when absent |

Mobile targets produce static SDKs only. Runtime packages flatten the selected
configuration into `bin/` and `lib/`. Symbol packaging does not generate dSYMs
or strip embedded debug information. Packages exclude vcpkg itself and host tools.

Checksums and CI package artifacts are emitted after consumer validation succeeds.
For distribution, follow the [release guide](v8-release.md).

## Consume an SDK

Verify the checksum, extract the SDK, and select the matching architecture and
configuration. Set `CMAKE_PREFIX_PATH` to its root. Desktop example:

```cmake
find_package(ZLIB CONFIG REQUIRED)
find_package(Boost 1.90 CONFIG REQUIRED COMPONENTS container unordered dynamic_bitset)
target_link_libraries(your_target PRIVATE
    ZLIB::ZLIB Boost::container Boost::unordered Boost::dynamic_bitset)
```

Use `--config Release|Debug` or `CMAKE_BUILD_TYPE` as appropriate. Match the
Windows CRT to the selected configuration. Deploy dynamic dependencies with the
application; Microsoft's CRT is not bundled. Windows Debug libraries require
the developer debug CRT.

Mobile consumers use the platform toolchain and static zlib target:

```cmake
find_package(ZLIB CONFIG REQUIRED COMPONENTS static
    PATHS "${STAR_SDK_ROOT}/share/zlib"
    NO_DEFAULT_PATH NO_CMAKE_FIND_ROOT_PATH)
target_link_libraries(your_target PRIVATE ZLIB::ZLIBSTATIC)
```

Android uses `ANDROID_PLATFORM=android-28`, the matching `ANDROID_ABI`, and
`ANDROID_STL=c++_static`. iOS uses the matching `iphoneos` or `iphonesimulator`
sysroot. Keep STL/linkage choices consistent with other native dependencies;
the separate Android V8 SDK uses `c++_shared`.

For complete relocated lookup and deployment checks, see the
[desktop](../tests/consumer/CMakeLists.txt),
[Android](../tests/android/CMakeLists.txt) and [iOS](../tests/ios/CMakeLists.txt)
consumers, including [Boost lookup](../tests/consumer/boost.cmake) and
[stdexec lookup](../tests/consumer/stdexec.cmake).

### stdexec

The SDK includes `<stdexec/execution.hpp>`, `<exec/task.hpp>` and the upstream
`STDEXEC::stdexec` CMake target. It requires C++20 and a compatible compiler:

```cmake
find_package(stdexec CONFIG REQUIRED)
target_link_libraries(your_target PRIVATE STDEXEC::stdexec)
```

Use `PUBLIC` when your public headers expose stdexec types. This interface target
propagates headers, compile options and upstream system dependencies such as
`Threads::Threads`; it does not link a stdexec static or dynamic library.
Keep the SDK version, compile definitions and C++ ABI consistent across modules.
Coroutine use across DLLs still requires an explicit lifetime/unload contract;
the SDK smoke test does not validate that contract.

The overlay disables the compiled `parallel_scheduler` backend. Applications
own their schedulers and execution resources; `exec::system_context` requiring
that backend is not part of the supported package. Optional Asio, TBB, Taskflow
and GPU integrations are not enabled or tested. Consumers do not build stdexec
or fetch its build tools. Overlay sources and patches are included in SDK provenance.

## Dependency maintenance

- Update the [vcpkg submodule](../tools/vcpkg) revision and manifest baseline
  together. CI uses the recorded revision, not submodule `--remote`.
- Put project overrides in [triplets](../triplets) or registered overlays in
  [vcpkg-configuration.json](../vcpkg-configuration.json).
- Preserve license files and provenance. Hosted toolchain images can change;
  pinned sources alone do not guarantee identical binaries.
- Upgrade downstream tag/checksum locks explicitly after publishing a new version.
