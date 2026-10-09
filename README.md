# Star Binaries

Build and distribute third-party C++ SDKs for star-platforms and star-engine.

- **Ordinary dependencies:** zlib, Boost.Container, Boost.Unordered,
  Boost.DynamicBitset and stdexec, resolved by the pinned [vcpkg manifest](vcpkg.json).
- **V8:** a separate GN build pinned by [v8-version.cmake](v8-version.cmake).
- **Targets:** Windows x64, macOS arm64, Android arm64/x64, and iOS
  device/simulator arm64. SDKs contain both Release and Debug.

## Documentation

| Task | Guide |
| --- | --- |
| Build or consume ordinary dependency SDKs | [Dependency SDKs](docs/dependencies.md) |
| Build or consume V8 SDKs | [V8 SDKs](docs/v8.md) |
| Publish, reuse V8, retry validation | [Release guide and memo](docs/v8-release.md) |

## Workflows

| Workflow | Purpose |
| --- | --- |
| [Build dependencies](.github/workflows/build.yml) | Build and test Windows/macOS dependency packages |
| [Build Android dependencies](.github/workflows/android.yml) | Build both Android SDKs; execute the x64 consumer |
| [Build iOS dependencies](.github/workflows/ios.yml) | Build both iOS SDKs; execute the simulator App |
| [Build V8 13.6](.github/workflows/v8.yml) | Manually build V8 when build inputs change |
| [Validate existing V8 SDKs](.github/workflows/validate-v8.yml) | Reuse SDKs and run current consumer checks without recompiling V8 |
| [Release all platforms](.github/workflows/release.yml) | Build ordinary dependencies, validate reused V8 SDKs, upload all assets |

Ordinary platform workflows run on pushes to `main`, pull requests, manual
dispatches and reusable release calls. V8 builds are manual. Publishing a GitHub
Release triggers distribution; pushing a tag or saving a draft alone does not.

Consumers should pin the release tag, asset name and SHA-256. Published packages
are corrected with a new version, rather than overwritten.
