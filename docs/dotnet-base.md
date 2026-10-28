# Base CoreCLR profile

[`base.json`](../scripts/dotnet/profiles/base.json) defines a proposed runtime for
native engine hosts. It is a **configuration draft**, tied to the revision in
[`dotnet-version.cmake`](../dotnet-version.cmake). Build scripts and CI still
produce the complete runtime; they do not consume this profile yet.

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

## Validation and activation

Metadata inspection of the pinned Windows x64 Release package found **24 roots
and 27 assemblies** after following `AssemblyRef` dependencies. The additional
assemblies are `System.ComponentModel`, `System.ComponentModel.Primitives` and
`System.Private.Uri`; none matches the exclusions. This checks managed references,
not execution of a reduced package. macOS dependency inspection remains pending.

Before activating the profile:

1. Resolve source projects (including facades under `shims`) and their build
   dependencies separately from shipped assemblies. Build the selected libraries
   instead of the complete `libs` subset. Build tools may still use XML internally.
2. Assemble a separately identified package with matching framework dependency
   metadata, native dependencies and payload checksums. The current complete
   `packs.product` archive cannot simply be relabeled as `base`.
3. Validate application assembly references, then run a relocated native-host
   consumer covering all five groups, plugin loading and missing dependencies.
   Replace the existing smoke test's Console output with a native callback for
   this profile. Verify Windows and macOS independently before enabling CI output.
