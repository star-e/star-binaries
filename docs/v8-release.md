# Publish existing V8 SDKs

The ordinary SDKs and six V8 SDKs share one `vX.Y.Z` release. Build V8 stays
manual; publication only downloads, verifies and uploads its outputs. No V8
compilation, automatic rebuild, or selection of a latest successful run occurs.

## Next build required after the simulator workflow change

[v8.yml](../.github/workflows/v8.yml) now separates simulator execution from
compilation and uses Node.js 24 Actions (`checkout@v6`, `upload-artifact@v6`,
`download-artifact@v7`, `setup-java@v5`). These workflow and validation changes
alter the V8 input fingerprint. The previously selected run `37718930358` failed
and cannot serve as the publication source for this revision.

- [ ] Commit the changes and manually start a new Build V8 run from that commit.
- [ ] After the complete run succeeds, update [v8-release.json](../v8-release.json)
  to its new run ID before publishing. Re-running the old run uses its old source.

## Retry simulator validation without rebuilding V8

The simulator build jobs compile/link the consumer and upload per-configuration
`v8-arm64-ios-simulator-star-<Release|Debug>-candidate` artifacts. These are not
release-ready SDKs. Separate `simulator-test` jobs download each candidate,
verify its checksum and source identity, rebuild only the small consumer against
the relocated SDK, and execute it in a simulator. They publish the identical ZIP
as a `-sdk` artifact only after receiving the current launch's passing result.
The merge job consumes `-sdk` artifacts, never candidates.

If simulator execution fails after a successful build, use **Re-run failed jobs**
in the same Actions run while its candidate artifacts remain available. Successful
build jobs are retained; simulator tests and failed downstream jobs can retry.
Do not start a new run or select **Re-run all jobs** merely to retry a transient
simulator failure. A source fix requires a new run, and expired candidates require
rebuilding. Publication still requires the entire selected run to succeed.

Container lookup has a 120-second timeout and retries a timeout once after five
seconds. Other errors fail immediately; attempts appear in the console and logs.
This bounds a transient recovery attempt without treating installation or launch
alone as a passing V8 test.

## Select the source before tagging

Edit `v8-release.json` on the commit that will be tagged. `source: null` is an
explicit unconfigured state: release validation fails before library builds.
It must be replaced with one of these two forms.

For the first V8 publication, choose a fully successful **Build V8 13.6** run
from this repository. Replace the example run ID with its actual Actions ID:

```json
{
  "schemaVersion": 1,
  "source": "workflow",
  "runId": 123456789
}
```

The run must be a completed successful manual execution of
`.github/workflows/v8.yml`. All six merged `v8-<triplet>-sdk` artifacts must exist
and be unexpired. Each must contain both Release and Debug. Fork, PR, failed,
partial, and mismatched-source runs are rejected. A failed upload/cleanup job
must be resolved before the run is eligible.

For subsequent releases, reuse a previous published stable release that already
contains V8 packages and `v8-provenance.json`. For example, when publishing
v0.1.5 and reusing v0.1.4:

```json
{
  "schemaVersion": 1,
  "source": "release",
  "tag": "v0.1.4"
}
```

The source must differ from the destination. A historical release containing
only ordinary dependencies is not a valid V8 source. Reuse preserves the ZIPs,
their SHA-256 files, and embedded provenance byte for byte. The new release
manifest records the reuse source while retaining the original build run/commit.
After the first publication, use Release assets instead of expiring Actions
artifacts for long-term reuse.

## How compatibility is checked

The fingerprint is SHA-256 over sorted Git paths, modes and blob IDs for:

- `v8-version.cmake`, `.gitattributes`, and `.github/workflows/v8.yml`;
- `scripts/build-v8.cmake`, `scripts/v8/`, and `patches/v8/`;
- `tests/v8/`, its shared `tests/ios/main.mm` and `Info.plist.in`, and the
  simulator smoke/cleanup scripts.

The selected run's source tree is read through GitHub's API and compared with
the release commit. Git identities avoid CRLF checkout differences. Ordinary
dependency manifests, the distribution version, and release tooling/configuration
are excluded. Updating Boost or choosing a new V8 release source does not change
the fingerprint; modifying V8 build/validation inputs requires a matching build.
This is deliberately conservative, including V8 CI runner/toolchain declarations.
It compares declared inputs, not the current contents of mutable hosted-runner
images; reused packages retain their original recorded build environment.

Existing Build V8 SDKs do not need an embedded fingerprint: their `identity.txt`
source must match the selected run, and the fingerprint comes from that source's
Git tree. The published `v8-provenance.json` records it for later reuse.

Validation also checks SDK SHA-256, upstream V8/depot_tools revisions, platform,
linkage, feature flags, both configuration headers/metadata and required library
entries. Archive metadata is extracted without executing any packaged scripts.
Device-only validation remains compile/link coverage; reuse does not establish
new physical-device or simulator runtime coverage.

## Workflow and local checks

`release.yml` adds a read-only V8 preparation job in parallel with ordinary
library builds. The final verification job combines all packages into a single
validated artifact. The workflow runs only on `release: published`; creating or
pushing a tag alone does not trigger it. Only the upload job can write release
assets. Upload retries check every
existing asset first, skip identical bytes, and reject conflicts without overwriting.

Local commands require Node.js 20+, Git and CMake 3.24+. Fetching/uploading also
requires GitHub CLI authenticated to this repository (`GH_TOKEN` in CI).

```sh
node --test tests/release/release.test.mjs
# Set RELEASE_TAG to the destination vX.Y.Z and GH_REPO to star-e/star-binaries.
node scripts/release/prepare-v8.mjs check-config
node scripts/release/prepare-v8.mjs prepare release-v8
node scripts/release/prepare-v8.mjs verify release-v8
```

Use a clean, committed source checkout and a new/empty output directory.
Preparation and verification do not modify GitHub. The upload command is used
by the release workflow after verifying the combined ordinary and V8 assets.
The offline tests create small synthetic SDKs and mock GitHub responses; real
artifact retrieval and publication still require a selected successful build.
