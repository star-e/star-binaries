# Base CoreCLR profile

[`base.json`](../scripts/dotnet/profiles/base.json) defines an experimental runtime
selection for native engine hosts, tied to [`dotnet-version.cmake`](../dotnet-version.cmake).
The package-only entry point reuses an extracted full SDK without rebuilding
CoreCLR. The unified [CoreCLR workflow](dotnet.md#github-actions) runs this step
automatically after preparing a full SDK.

## Package and validate

On Windows, use a Visual Studio x64 Developer PowerShell. On macOS, use a native
arm64 host with the [consumer prerequisites](dotnet.md#build-and-verify).
From the repository root:

```powershell
cmake "-DSTAR_SDK_ROOT=D:/SDKs/star-dotnet-11.0.0-rc.3.26522.148-x64-windows-star-release-sdk" -DPROFILE=base -P scripts/package-dotnet.cmake
```

The input must be an extracted, complete SDK from the pinned source build.
The script verifies its provenance and every payload checksum, computes the
managed dependency closure, copies selected files to a fresh staging directory,
and updates the framework `.deps.json`. It preserves assembly contents and the
hostfxr/framework directory layout. The result includes hosting headers/libraries,
licenses, the profile, selection report, source identity and new checksums.
It omits the `dotnet` CLI executable and is consumed by a native host.

The archive is published locally only after relocated consumer tests and four
selection rejection checks pass. Output defaults to `out/dotnet/<triplet>/Release/`:

```text
star-dotnet-11.0.0-rc.3.26522.148-x64-windows-star-release-base-sdk.zip
star-dotnet-11.0.0-rc.3.26522.148-arm64-osx-star-release-base-sdk.tar.gz
```

`OUTPUT_DIR` can select another output location outside the input SDK.
`DOTNET_EXECUTABLE` can supply the pinned compiler SDK; otherwise it is acquired
automatically. The original SDK remains intact. Inspect
`provenance/selection.json` for the actual managed references and native imports.

Validate a distributed base archive and its adjacent `.sha256`:

```powershell
cmake "-DARCHIVE=D:/SDKs/star-dotnet-11.0.0-rc.3.26522.148-x64-windows-star-release-base-sdk.zip" -DPROFILE=base -P scripts/dotnet/validate-archive.cmake
```

Extracted packages use the normal `scripts/dotnet/validate.cmake` entry point,
which detects the profile and checks consumer assembly references before execution.

## Included capabilities

| Group | Intended use |
| --- | --- |
| Core | Primitive types, strings, arrays, exceptions, GC, delegates, `Span<T>`, `Memory<T>` and buffer pools |
| Collections | `List<T>`, `Dictionary<K,V>`, sets, concurrent and observable collections |
| Threading | Threads, thread pool, synchronization, timers, cancellation, `Task`, `ValueTask` and async/await |
| Interop | P/Invoke, native callbacks, `SafeHandle`, `GCHandle`, `Marshal`, `NativeLibrary` and unsafe helpers |
| Assembly loading | Reflection and `AssemblyLoadContext` for loading application assemblies and their dependencies |

The profile retains the complete CoreLib and selected facade assemblies (which
forward types to their implementations). It does not trim methods or types:
future dynamically loaded assemblies cannot be fully analyzed ahead of time.
See [.NET trimming limitations](https://learn.microsoft.com/en-us/dotnet/core/deploying/trimming/incompatibilities).

XML, JSON, HTTP/networking, database libraries, cryptography assemblies,
compression, LINQ, regular expressions, Console, immutable collections,
Channels/Dataflow, dynamic binding and language compatibility libraries are
outside the default selection. They can be added deliberately when required.
Logging should use a native host callback.

These are assembly selection rules, not an API or security sandbox. CoreLib
already contains reflection, file access and other capabilities that remain
available. Excluding `System.Reflection.Emit*`, for example, does not remove
every emit API from CoreLib.

## Selection rules

- `managedRoots` groups assembly names without `.dll`. Include their recursive
  managed dependencies, even when a dependency belongs to another feature group.
- `excludedManagedPatterns` uses `*` as a wildcard over assembly names. A matching
  dependency is an error to resolve explicitly, rather than silently removing it.
- `nativeRoots` lists required shipped native libraries, relative to the existing
  framework, hostfxr and nethost locations. Audit native imports and dynamically
  loaded libraries separately; OS libraries are not copied into the package.
- Preserve upstream globalization behavior. At this pin, globalization native
  code is [statically linked into CoreCLR](https://github.com/dotnet/runtime/blob/474ed963699fc29809015392738a15231aaae2de/src/coreclr/dlls/mscoree/coreclr/CMakeLists.txt);
  its ICU/system dependencies still need platform validation. macOS also needs
  `libSystem.Native.dylib`.
- Application assemblies must depend on the selected framework surface or
  explicitly deployed application dependencies. Do not resolve missing framework
  libraries from an unrelated installed .NET runtime.

`AssemblyLoadContext` allows loading plugins, but does not make absent framework
libraries available. The compiler's full .NET reference pack also does not
guarantee that an API exists in this smaller deployment. See the official
[assembly loading model](https://learn.microsoft.com/en-us/dotnet/core/dependency-loading/understanding-assemblyloadcontext).

## Validation and remaining work

Metadata inspection of the pinned Windows x64 Release package found **24 roots
and 27 assemblies** after following `AssemblyRef` dependencies. The additional
assemblies are `System.ComponentModel`, `System.ComponentModel.Primitives` and
`System.Private.Uri`; none matches the exclusions.

For this Windows build, the SDK payload decreased from **81.41 MiB to 26.61 MiB**;
the ZIP decreased from **35.56 MiB to 11.72 MiB**. These measurements include the
native host components and SDK metadata, not just the 27 managed assemblies.

The Windows base package has passed the native-host consumer: allocation/GC,
collections, memory pools, globalization, Task/ValueTask, cancellation, timers,
threads, pinned memory, native callbacks and library loading, and a collectible
plugin with a private dependency. Missing assemblies, excluded XML/Console and a
missing framework version are rejected. Logging uses the native callback.

Package checks also reject an excluded transitive dependency, missing root,
revision mismatch and missing plugin dependency. Managed reference checks cannot
prove all dynamic/native loading paths or third-party plugin compatibility.
Debugging/dump utilities are not included. macOS execution remains unverified.

This reduces deployment size, not source build work. Selective compilation will
need a separate source-project closure (including facades under `shims`) and
packaging without the complete `libs` / `packs.product` output. Build tools may
still use XML internally. Mobile targets remain subsequent work.
