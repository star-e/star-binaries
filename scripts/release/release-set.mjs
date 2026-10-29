import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, manifestName, readJson, verifyChecksum } from './common.mjs';
import { sdkManifestName, verifySdkSet } from './prepare-sdk.mjs';
import { verifyV8Set } from './prepare-v8.mjs';
import { dotnetManifestName, verifyDotnetSet } from './prepare-dotnet.mjs';

export const releaseManifestName = 'release-provenance.json';

async function inspectRelease(options) {
  const manifests = [];
  // Avoid expanding large archives in parallel on a release runner.
  for (const [family, name, verify] of [['sdk', sdkManifestName, verifySdkSet],
    ['v8', manifestName, verifyV8Set], ['dotnet', dotnetManifestName, verifyDotnetSet]]) {
    const manifest = await verify(options);
    manifests.push({ family, name, manifest, sha256: await hashFile(path.join(options.directory, name)) });
  }
  const expected = manifests.flatMap(({ name, manifest }) => [name, `${name}.sha256`,
    ...manifest.assets.flatMap(asset => [asset.name, `${asset.name}.sha256`])]);
  const summaryFiles = [releaseManifestName, `${releaseManifestName}.sha256`];
  assert.deepEqual(readdirSync(options.directory).filter(name => !summaryFiles.includes(name)).sort(),
    expected.sort(), 'Unexpected or missing release assets');
  return { schemaVersion: 1, repository: options.repository, releaseTag: options.tag,
    releaseCommit: manifests[0].manifest.releaseCommit,
    packages: Object.fromEntries(manifests.map(({ family, name, manifest, sha256 }) => [family,
      { manifest: name, sha256, source: manifest.source, origin: manifest.origin }])) };
}

export async function recordReleaseSet(options) {
  const summary = await inspectRelease(options);
  const file = path.join(options.directory, releaseManifestName);
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  writeFileSync(`${file}.sha256`, `${await hashFile(file)}  ${releaseManifestName}\n`);
  for (const [family, info] of Object.entries(summary.packages)) {
    console.log(`${family}: build run ${info.origin.runId}, commit ${info.origin.headSha}`);
  }
  return summary;
}

export async function verifyReleaseSet(options) {
  const file = path.join(options.directory, releaseManifestName);
  await verifyChecksum(file);
  assert.deepEqual(readJson(file), await inspectRelease(options), 'Release source summary mismatch');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv[2], 'Usage: node scripts/release/release-set.mjs <directory>');
    await recordReleaseSet({ root: process.cwd(), directory: path.resolve(process.argv[2]),
      tag: process.env.RELEASE_TAG, repository: process.env.GH_REPO || process.env.GITHUB_REPOSITORY });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
