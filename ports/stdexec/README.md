# stdexec overlay

Based on `ports/stdexec` in vcpkg baseline
`a1cae005c39be7b18ba319fced856b68d7276271` (version `2026-05-25#1`).
The upstream source is NVIDIA/stdexec commit
`fee4d651494014610a277540f209cae56011e47f`, verified by the SHA-512 in
[portfile.cmake](portfile.cmake). The overlay version is `2026-05-25#2`.

Changes from the baseline port:

- Disable `STDEXEC_BUILD_PARALLEL_SCHEDULER` and remove its Windows static-library restriction.
- Remove empty library directories after installing the header-only package.
- Record the upstream license as Apache-2.0 WITH LLVM-exception.

The source pin, build-tool pins, optional feature definitions and six upstream
vcpkg patches are retained. The manifest enables no optional features.
When updating the vcpkg baseline, review this overlay too: it overrides the
registry port and does not advance automatically.

The copied vcpkg port files are covered by [Microsoft's MIT license](LICENSE-vcpkg.txt).
The installed stdexec SDK retains its own upstream license in `share/stdexec/copyright`.

Consumers use `find_package(stdexec CONFIG REQUIRED)` and `STDEXEC::stdexec`.
See [Dependency SDKs](../../docs/dependencies.md#stdexec) for the supported contract.
