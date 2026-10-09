# Release guide and V8 reuse

Ordinary dependencies and six V8 SDKs share one `vX.Y.Z` release. Publication
builds ordinary dependencies and validates existing V8 SDKs; it never recompiles
V8. For building or consuming packages, see [dependency SDKs](dependencies.md)
and [V8 SDKs](v8.md).

## Publish a release

1. Set `version-string` in [vcpkg.json](../vcpkg.json) and select the V8 source
   in [v8-release.json](../v8-release.json), then commit and push.
2. Optionally run **Validate existing V8 SDKs** on that branch. Set
   **Destination version** to the intended `vX.Y.Z`. This only prepares validation
   records; it neither creates a tag nor publishes a release.
3. Open **Releases > Draft a new release**. Select or create the matching
   `vX.Y.Z` tag on the intended commit, enter release notes, and **Publish release**.
4. Check **Release all platforms**. Ordinary platform builds, V8 consumer
   validation and package verification must pass before assets are uploaded.

The [release workflow](../.github/workflows/release.yml) triggers only on
`release: published`. A draft or tag push alone does not trigger it.
The stable tag must match the manifest version; prerelease tags are unsupported.
The release commit must contain the workflows and scripts to run.

The release is visible immediately; assets arrive after checks succeed. A failed
run leaves it published with missing/incomplete assets. Only the upload job has
repository write permission. The repository must allow adding assets to the
published release; this flow cannot upload to an immutable release.

## Select the V8 source

### First publication: a successful build

```json
{
  "schemaVersion": 1,
  "source": "workflow",
  "runId": 123456789
}
```

Use a completed successful manual **Build V8 13.6** run from this repository,
not a **Validate existing V8 SDKs** run. All six merged `v8-<triplet>-sdk`
artifacts must exist, be unexpired and contain both configurations.
Failed, partial, fork and candidate-only builds are rejected.

### Later publications: an existing release

For example, to publish `v0.1.5` using the V8 packages from `v0.1.4`:

```json
{
  "schemaVersion": 1,
  "source": "release",
  "tag": "v0.1.4"
}
```

Use the actual published stable tag containing all six V8 SDKs and
`v8-provenance.json`; it must differ from the destination. These tags are examples.
Release assets avoid depending on expiring Actions artifacts. Reuse preserves ZIPs,
sidecars and embedded build metadata byte for byte.

## Validation without rebuilding V8

After editing consumer tests or simulator scripts, keep the existing V8 source.
Commit the changes and start **Actions > Validate existing V8 SDKs > Run workflow**
on the updated branch. It downloads SDKs and compiles only the small consumers.

The [validation workflow](../.github/workflows/validate-v8.yml) checks Release and
Debug on all six targets. Windows, macOS, Android x64 and iOS simulator execute
consumers; Android arm64 and iOS device perform compile/link checks.

Manual validation is optional preflight. Publication automatically calls the same
workflow and performs its own validation. A manual validation run ID does not
replace the build source in `v8-release.json`.

### Compatibility and provenance

Schema 2 separates two fingerprints, computed from Git paths, modes and blob IDs:

| Fingerprint | Inputs | Effect of a change |
| --- | --- | --- |
| Build | V8/depot_tools pins, .gitattributes, v8.yml, build-v8.cmake, patches/v8/, non-validation scripts/v8/ files | Requires a matching build |
| Validation | scripts/v8/validate*, scripts/release/, validate-v8.yml, tests/v8/, shared iOS App sources and simulator helpers | Revalidate existing SDKs |

Ordinary manifests and distribution versions do not force V8 rebuilds.
The entire `v8.yml` remains a conservative build input, including runner/toolchain
setup; make validation-only workflow changes in `validate-v8.yml`.

Preparation checks source identity, build fingerprint, checksums, configuration
metadata and required libraries. It writes a pending manifest that cannot pass
release verification. Successful host jobs record the exact SDK checksum, original
build origin, validation commit/fingerprint, Actions run ID and coverage.
Finalization requires six receipts covering both configurations.

Legacy schema-1 manifests are verified against the original Git tree before
migration. SDK bytes are not rewritten. Every release gets fresh validation
records, including when reusing another release. These checks do not establish
physical-device coverage or byte-for-byte reproducibility across hosted images.

## Failures and retries

| Failure | Action |
| --- | --- |
| Network or transient simulator failure | Re-run failed jobs; successful SDK builds need not run again |
| Consumer/test-script bug | Commit the fix and start a new validation run |
| Build fingerprint mismatch | Inspect changed build inputs; select or create a matching Build V8 run |
| Actions artifacts expired | Use an existing release; rebuild only if no suitable SDK remains |
| Upload interrupted | Retry with the existing validated artifact |
| Published same-name asset has different bytes | Publish corrections under a new version |

**Re-running an old Actions run uses its old source.** A script fix needs a new
run; for a published release, changing a branch does not update its tag's scripts.
Avoid rebuilding ordinary packages just to retry an upload: ZIP bytes may change.
Upload skips identical assets and rejects conflicts before uploading new files.

During **Build V8**, simulator configuration jobs upload candidates first; execution
jobs promote the same bytes after success. Re-run failed jobs in that same run
while candidates exist. Independent validation requires a complete successful SDK
set, so it does not recover an incomplete build from candidates.

V8 validation boots/waits before installation; the ordinary iOS workflow boots
the simulator before building. Shared container lookup allows 120 seconds and
retries a timeout once. After `simctl launch` succeeds or
times out, it waits up to 120 seconds for the current token's success receipt.
Missing, stale or failed receipts fail validation. Explicit launch errors fail
without the extra wait. A PID or successful launch alone is not a passing test.

Check the first failed build/consumer step, then its uploaded prepare/runtime logs.
A compile/link-only target may have no `*.log` files; the upload warning alone
does not mean validation failed.

## Local checks

From a clean committed checkout, with Node.js 20+, Git and CMake 3.24+:

```sh
node --test tests/release/release.test.mjs tests/ios/simulator-smoke.test.mjs
```

Fetching also requires authenticated GitHub CLI (`GH_TOKEN`). Set `RELEASE_TAG`
and `GH_REPO`, then use `prepare-v8.mjs check-config` or
`prepare-v8.mjs prepare <empty-directory>`. Preparation alone is not a passing
validation. CI runs `validate-v8.mjs` on each host, collects receipts, then uses
`prepare-v8.mjs finalize <directory> <receipts>` and `verify <directory>`.

The final release requires ordinary SDKs for all targets, desktop Release/Debug
runtime packages, six V8 SDKs, provenance and SHA-256 sidecars. Available desktop
symbols are included. Consumers should lock tag, filename and checksum.

## Release memo: 2026-10-09

The maintainer confirmed independent validation and subsequent publication succeeded.
Build source configured at that time: `37745543587`.
Validation run discussed: [37803782660](https://github.com/star-e/star-binaries/actions/runs/37803782660).

The maintainer subsequently selected `v0.1.4` as the published V8 source.
`v8-release.json` now reuses that release for the next `v0.1.5` publication,
avoiding dependence on expiring workflow artifacts. Publication still validates
all six SDKs without rebuilding V8. Physical-device runtime coverage remains unchanged.
