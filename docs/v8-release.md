# Publish existing V8 SDKs

The ordinary SDKs and six V8 SDKs share one `vX.Y.Z` release. Build V8 stays
manual; publication only downloads, verifies and uploads its outputs. No V8
compilation, automatic rebuild, or selection of a latest successful run occurs.

## After changing a test or simulator script

Keep the successful build source in [v8-release.json](../v8-release.json).
Commit the change and run **Actions > Validate existing V8 SDKs > Run workflow**,
selecting the updated branch and supplying the intended destination `release_tag`.
This workflow downloads the existing six merged SDKs, compiles only the small
consumers, and validates Release and Debug on their corresponding hosts. It never
checks out or builds V8 sources and does not publish a release.

The release workflow calls the same validation workflow automatically. A manual
run is optional preflight; publication performs its own validation. There is no
need to change the Build V8 `runId` after a validation-only change. Re-running an
old workflow run still uses its old source; start a new validation run to pick up
the fix. Failed/incomplete Build V8 runs and candidate-only SDKs remain unsupported
as release sources; this path reuses complete SDKs from a successful build/release.

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
simulator failure. Once a full successful SDK set exists, validation-only source
fixes use the independent workflow above. Expired candidates require rebuilding.
Publication still requires the selected Build V8 run to have succeeded.

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

Schema 2 records separate SHA-256 fingerprints over sorted Git paths, modes and
blob IDs:

- **Build:** `v8-version.cmake`, `.gitattributes`, `.github/workflows/v8.yml`,
  `scripts/build-v8.cmake`, `patches/v8/`, and non-validation files in `scripts/v8/`.
  This includes GN arguments, SDK packaging/configuration and library patches.
- **Validation:** `scripts/v8/validate*`, `scripts/release/`,
  `.github/workflows/validate-v8.yml`, `tests/v8/`, shared `tests/ios/main.mm` and
  `Info.plist.in`, and simulator smoke/cleanup scripts.

The selected run's source tree is read through GitHub's API and compared with
the release commit's build fingerprint. Git identities avoid CRLF checkout
differences. Updating Boost or selecting a release source does not require a new
V8 build. Validation inputs may differ; fresh validation records are required.
The entire Build V8 workflow remains a conservative build input, including its
runner/toolchain setup. Changes inside `v8.yml` can still require a matching build;
the independent validation workflow avoids changing that file for test fixes.
It compares declared inputs, not the current contents of mutable hosted-runner
images; reused packages retain their original recorded build environment.

Existing Build V8 SDKs do not need an embedded fingerprint: their `identity.txt`
source must match the selected run, and the fingerprint comes from that source's
Git tree. The published `v8-provenance.json` records it for later reuse. Legacy
schema-1 releases are accepted only after verifying their combined fingerprint
against the recorded origin Git tree, then checking the new build fingerprint.
SDK ZIPs and their embedded origin metadata are never rewritten during migration.

Preparation writes a **pending** manifest with no validation receipts. It cannot
pass release verification or upload. Each successful host job records the exact
SDK checksum, original build origin, validation commit/fingerprint, Actions run
ID, both configurations and actual coverage (`runtime` or `compile-link`). Finalization
requires exactly one valid receipt per triplet and embeds all six in the manifest.
Every release revalidates its SDKs, including SDKs reused from an earlier release.

Validation also checks SDK SHA-256, upstream V8/depot_tools revisions, platform,
linkage, feature flags, both configuration headers/metadata and required library
entries. Metadata inspection does not execute packaged scripts; subsequent consumer
validation loads the SDK's CMake package and libraries on the designated hosts.
Android arm64 and iOS device retain compile/link coverage; Windows, macOS,
Android x64 and iOS simulator execute consumers. This does not establish
physical-device coverage for the compile/link-only targets.

## Workflow and local checks

`release.yml` calls the read-only V8 preparation/validation workflow in parallel
with ordinary library builds. The final verification job combines all packages into a single
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
# Preparation alone cannot pass verification. The CI validation jobs run
# validate-v8.mjs on each target host, then collect receipts into one directory.
node scripts/release/prepare-v8.mjs finalize release-v8 receipts
node scripts/release/prepare-v8.mjs verify release-v8
```

Use a clean, committed source checkout and a new/empty output directory.
Preparation and verification do not modify GitHub. The upload command is used
by the release workflow after verifying the combined ordinary and V8 assets.
The offline tests create small synthetic SDKs and mock GitHub responses; real
artifact retrieval and publication still require a selected successful build.
