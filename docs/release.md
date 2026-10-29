# Build and release

Three manual build entries produce packages for six targets: Windows x64, macOS
arm64, Android arm64/x64 and iOS device/simulator arm64. Builds and publication are
separate. SDK, V8 and .NET archives keep their existing names and layouts.

| Entry | Output |
| --- | --- |
| [Build SDK](../.github/workflows/sdk.yml) | Six dependency SDKs, desktop runtime packages and available symbols |
| [Build V8 13.6](../.github/workflows/v8.yml) | Six SDKs, each containing Release and Debug |
| [Build .NET](../.github/workflows/dotnet.yml) | Four desktop full/base SDKs and four mobile runtime packs |
| [Release](../.github/workflows/release.yml) | Existing packages, checksums and provenance attached to a published Release |

Pushes and pull requests do not start workflows. Use **Actions > Run workflow**.
Each Build covers every platform; failed jobs can be retried in the same run.
Successful partial artifacts remain useful for debugging, but release selection
requires a complete successful run. Release-script checks are an internal
prerequisite for Build SDK, Build .NET and Release. V8 keeps its existing build
workflow unchanged so the current published V8 source remains reusable.

## Select sources

[release-inputs.json](../release-inputs.json) is the single configuration:

```json
{
  "schemaVersion": 1,
  "sdk": { "source": "workflow", "runId": "latest" },
  "v8": { "source": "release", "tag": "v0.1.4" },
  "dotnet": { "source": "workflow", "runId": "latest" }
}
```

Every family accepts the same three forms:

- `workflow` / `runId: "latest"`: newest successful compatible run on `main`
  whose required artifacts are still available. Incompatible, expired or partial
  runs are skipped; if none qualify, publication fails.
- `workflow` / a positive numeric `runId`: exactly that run, with no fallback.
- `release` / a previous stable `tag`: reuse its packages and provenance without
  changing archive bytes. The source and destination tags must differ.

Selection checks the workflow, repository, source inputs and complete package
set. Input fingerprints include relevant pins, scripts and toolchain settings;
SDK also includes the vcpkg submodule commit. The three families may originate
from different commits when their own inputs match the release commit.

`latest` resolves once for each family, and all of that family's platforms come
from the selected run. The published manifest records the concrete Run ID.
For deterministic retries, put numeric IDs in the configuration before tagging;
a new release attempt can otherwise select a newer matching run.

The first unified SDK publication needs a successful **Build SDK** run, which
adds `sdk-build.json` to the `sdk-packages` artifact. Legacy SDK releases without
`sdk-provenance.json` cannot be reused. Build .NET must also run after its workflow
changes; matching desktop caches are still revalidated and reused. Existing V8
`v0.1.4` selection is preserved, with fresh consumer validation during release.

## Publish

1. Set `vcpkg.json`'s version and the three release sources; commit the changes.
2. Run the required Builds on that commit and wait for all their jobs to pass.
   Already compatible V8/release sources can be reused.
3. On GitHub, **Draft a new release**, choose the intended commit and matching
   `vX.Y.Z` tag, enter notes, then **Publish release**.
4. Release checks the configuration, fetches existing artifacts, runs current V8
   consumer checks, validates every archive and uploads the complete set.

Release never invokes the SDK, V8 or CoreCLR source builds. Existing validation
coverage remains explicit: SDK/V8 Android arm64 and iOS device are compile/link
checks; their desktop, Android x64 and iOS simulator consumers execute. .NET
desktop packages execute; mobile packs remain experimental and record
`runtimeTested: false`.

The release contains `sdk-provenance.json`, `v8-provenance.json`,
`dotnet-provenance.json` and a combined `release-provenance.json`, each with a
checksum. The combined manifest fixes all three origins and manifest hashes.
SDK symbol archives, when produced, are preserved alongside runtime archives.

## Retry and retention

Use **Re-run failed jobs**, or manually run **Release** with the existing
published tag. The configuration and scripts are read from that tag. A tag push
or draft alone starts no workflow. Only the final upload job can write releases.
Manual retries require the calling ref's release workflows to match that tag;
otherwise rerun the original run, or dispatch with the tag as `--ref` through CLI.

An identical existing asset is skipped; a same-name asset with different bytes
fails before any new uploads. Corrections require a new version, not moving a
published tag or overwriting archives. A failed upload may leave a partial
published release; retry it with the same selected sources.

This preserves the existing publish-then-upload model and therefore requires
releases that permit adding assets after publication. Immutable releases need a
separate draft-before-publish design.

Actions artifacts use repository retention settings. Expired artifacts cannot
be published: select a compatible previous Release or rebuild. A cache is an
input to Build, never an alternative release artifact source.

Local checks: `node --test tests/release/*.test.mjs` and
`node --test tests/ios/simulator-smoke.test.mjs`. Release fixture tests use committed
input fingerprints; run from a clean committed checkout or an isolated snapshot.
