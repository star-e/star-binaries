# Star Binaries

Build and distribute third-party C++ SDKs for star-platforms and star-engine.

- **Ordinary dependencies:** Boost.Container, Boost.Unordered,
  Boost.DynamicBitset, stdexec and Microsoft GSL (`ms-gsl`), resolved by the pinned
  [vcpkg manifest](vcpkg.json).
- **V8:** a separate GN build pinned by [v8-version.cmake](v8-version.cmake).
- **CoreCLR:** .NET 11 RC3 Release source builds: Windows/macOS hosting SDKs and
  Android/iOS runtime packs, pinned by [dotnet-version.cmake](dotnet-version.cmake).
  Mobile compilation and device execution are separate validation stages.
- **Targets:** Windows x64, macOS arm64, Android arm64/x64, and iOS
  device/simulator arm64. SDKs contain both Release and Debug.

## Documentation

| Task | Guide |
| --- | --- |
| Build or consume ordinary dependency SDKs | [Dependency SDKs](docs/dependencies.md) |
| Build or consume V8 SDKs | [V8 SDKs](docs/v8.md) |
| Build or validate the CoreCLR SDK | [CoreCLR SDK](docs/dotnet.md) |
| Publish and reuse SDK, V8 and .NET packages | [Release guide](docs/release.md) |

## Workflows

| Manual entry | Purpose |
| --- | --- |
| [Build SDK](.github/workflows/sdk.yml) | Build all six ordinary dependency targets and run their consumers |
| [Build V8 13.6](.github/workflows/v8.yml) | Build and validate all six V8 SDKs, with Release and Debug |
| [Build .NET](.github/workflows/dotnet.yml) | Validate two desktop full SDKs; build and check four mobile runtime packs |
| [Release](.github/workflows/release.yml) | Collect existing packages, validate and upload them; never rebuild libraries |

Builds run only through **Run workflow**. Pushes and pull requests do not start
workflows. Release-script checks and existing-V8 validation are internal reusable
workflows, without separate manual entries.

[release-inputs.json](release-inputs.json) selects each package family from a
complete matching build run or a previous Release. Publishing a GitHub Release
starts collection; **Run workflow** on Release with its existing tag retries it.
A tag push or saving a draft does not publish packages. Archives stay separate
by family/platform, with existing names and layouts.

Consumers should pin the release tag, asset name and SHA-256. Published packages
are corrected with a new version, rather than overwritten.
