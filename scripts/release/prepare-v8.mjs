import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, archiveName, assertNames, extractSelected, fingerprint, hashFile, hashPattern,
  localFingerprint, manifestName, readJson, run, shaPattern, stableTag, triplets,
  v8Version, validateSource, validateV8Archive, verifyChecksum, withTemp } from './common.mjs';

export function validateRun(runInfo, runId, repository) {
  assert.equal(runInfo.id, runId, 'Wrong workflow run');
  assert.equal(runInfo.path, '.github/workflows/v8.yml', 'Source is not Build V8');
  assert.equal(runInfo.event, 'workflow_dispatch', 'Source must be a manual Build V8 run');
  assert.equal(runInfo.status, 'completed', 'Build V8 has not completed');
  assert.equal(runInfo.conclusion, 'success', 'Build V8 must succeed, including validation');
  assert.equal(runInfo.head_repository?.full_name?.toLowerCase(), repository.toLowerCase(), 'Fork artifacts are not release inputs');
  assert(shaPattern.test(runInfo.head_sha), 'Missing build source commit');
  return { runId, headSha: runInfo.head_sha };
}

export function validateManifest(manifest, repository, tag, expectedFingerprint, version) {
  assert.equal(manifest.schemaVersion, 2, 'Unsupported V8 provenance schema');
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.releaseTag, tag, 'V8 provenance belongs to another release');
  assert.equal(manifest.buildFingerprint, expectedFingerprint, 'V8 build inputs changed; select a new Build V8 run');
  assert.equal(manifest.v8Version, version.version);
  assert(shaPattern.test(manifest.origin?.headSha), 'Invalid V8 origin commit');
  assert(Number.isSafeInteger(manifest.origin?.runId) && manifest.origin.runId > 0, 'Invalid V8 origin run');
  assert.deepEqual(manifest.assets?.map(asset => asset.triplet).sort(), [...triplets].sort(), 'Incomplete V8 platform set');
  assert(hashPattern.test(manifest.validationFingerprint), 'Invalid validation fingerprint');
  for (const asset of manifest.assets) {
    assert.equal(asset.name, archiveName(version.version, asset.triplet));
    assert(hashPattern.test(asset.sha256), 'Invalid V8 archive checksum');
  }
}

export const validationMode = triplet => ['arm64-ios-star', 'arm64-android-star'].includes(triplet) ? 'compile-link' : 'runtime';

export function validateReceipts(manifest, receipts) {
  assert.deepEqual(receipts.map(item => item.triplet).sort(), [...triplets].sort(), 'Incomplete V8 validation set');
  for (const receipt of receipts) {
    const asset = manifest.assets.find(item => item.triplet === receipt.triplet);
    assert.equal(receipt.schemaVersion, 1);
    assert.equal(receipt.repository, manifest.repository, 'Validation repository mismatch');
    assert.equal(receipt.validationCommit, manifest.releaseCommit, 'Validation commit mismatch');
    assert.equal(receipt.validationFingerprint, manifest.validationFingerprint, 'Validation scripts changed');
    assert.equal(receipt.buildFingerprint, manifest.buildFingerprint, 'Validation build fingerprint mismatch');
    assert.deepEqual(receipt.origin, manifest.origin, 'Validation origin mismatch');
    assert.equal(receipt.name, asset.name, 'Validation archive mismatch');
    assert.equal(receipt.sha256, asset.sha256, 'Validation checksum mismatch');
    assert.deepEqual(receipt.configurations, ['Release', 'Debug'], 'Both configurations must be validated');
    assert.equal(receipt.mode, validationMode(receipt.triplet), 'Incorrect validation coverage');
    assert.equal(receipt.result, 'passed', 'V8 consumer validation failed');
    assert(Number.isSafeInteger(receipt.runId) && receipt.runId > 0, 'Missing validation run ID');
  }
}

async function writeManifest(directory, manifest) {
  const metadata = path.join(directory, manifestName);
  writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${metadata}.sha256`, `${await hashFile(metadata)}  ${manifestName}\n`);
}

function oneAsset(assets, name) {
  const matches = assets.filter(asset => asset.name === name);
  assert.equal(matches.length, 1, `Missing or ambiguous asset: ${name}`);
  return matches[0];
}

export async function prepareV8({ root, output, tag, config, client }) {
  validateSource(config, tag);
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Use an empty V8 output directory');
  const version = v8Version(root);
  const expectedFingerprint = localFingerprint(root);
  const validationFingerprint = localFingerprint(root, 'validation');
  mkdirSync(output, { recursive: true });
  return withTemp(async work => {
    let origin, previous, sourceAssets;
    if (config.source === 'workflow') {
      origin = validateRun(client.api(`actions/runs/${config.runId}`), config.runId, client.repository);
      assert.equal(fingerprint(client.tree(origin.headSha)), expectedFingerprint,
        'V8 inputs differ from the selected build; select a matching Build V8 run');
      sourceAssets = client.pages(`actions/runs/${config.runId}/artifacts`, 'artifacts');
      for (const triplet of triplets) {
        const artifact = oneAsset(sourceAssets, `v8-${triplet}-sdk`);
        assert(!artifact.expired, `Expired artifact: ${artifact.name}; use an existing release or rebuild V8`);
        assert.equal(artifact.workflow_run?.head_sha, origin.headSha, 'Artifact source mismatch');
        assert(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'Invalid artifact ID');
      }
    } else {
      const release = client.api(`releases/tags/${config.tag}`);
      assert.equal(release.tag_name, config.tag);
      assert(!release.draft && !release.prerelease, 'Reuse requires a published stable release');
      sourceAssets = client.pages(`releases/${release.id}/assets`);
      const metadata = path.join(work, manifestName);
      for (const name of [manifestName, `${manifestName}.sha256`]) {
        client.downloadReleaseAsset(oneAsset(sourceAssets, name), path.join(work, name));
      }
      await verifyChecksum(metadata);
      previous = readJson(metadata);
      if (previous.schemaVersion === 1) {
        // Migrate legacy provenance only after checking its original combined
        // fingerprint against the recorded build tree. Never relabel old bytes.
        const sourceTree = client.tree(previous.origin?.headSha);
        assert.equal(previous.inputFingerprint, fingerprint(sourceTree, 'legacy'), 'Legacy V8 provenance mismatch');
        previous = { ...previous, schemaVersion: 2,
          buildFingerprint: fingerprint(sourceTree), validationFingerprint };
      }
      validateManifest(previous, client.repository, config.tag, expectedFingerprint, version);
      origin = previous.origin;
    }
    const assets = [];
    for (const triplet of triplets) {
      const name = archiveName(version.version, triplet);
      const input = path.join(work, triplet);
      mkdirSync(input);
      if (config.source === 'workflow') {
        const artifact = oneAsset(sourceAssets, `v8-${triplet}-sdk`);
        const envelope = path.join(work, `${triplet}-artifact.zip`);
        client.download(`actions/artifacts/${artifact.id}/zip`, envelope);
        if (artifact.digest) assert.equal(`sha256:${await hashFile(envelope)}`, artifact.digest, 'Artifact digest mismatch');
        extractSelected(envelope, input, [name, `${name}.sha256`]);
        unlinkSync(envelope);
      } else {
        for (const assetName of [name, `${name}.sha256`]) {
          client.downloadReleaseAsset(oneAsset(sourceAssets, assetName), path.join(input, assetName));
        }
      }
      assertNames(input, [name, `${name}.sha256`]);
      const file = path.join(input, name);
      const sha256 = await validateV8Archive(file, triplet, version, origin.headSha, path.join(work, `${triplet}-metadata`));
      if (previous) assert.equal(sha256, previous.assets.find(asset => asset.triplet === triplet).sha256, 'Reused V8 asset changed');
      assets.push({ triplet, name, sha256 });
      for (const assetName of [name, `${name}.sha256`]) {
        copyFileSync(path.join(input, assetName), path.join(output, assetName));
        unlinkSync(path.join(input, assetName));
      }
    }
    const manifest = { schemaVersion: 2, repository: client.repository, releaseTag: tag,
      releaseCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), source: config,
      origin, buildFingerprint: expectedFingerprint, validationFingerprint,
      v8Version: version.version, assets, validations: [] };
    await writeManifest(output, manifest);
    return manifest;
  });
}

// Recheck the exact files passed between jobs; never trust only a job outcome.
export async function verifyV8Set({ root, directory, tag, repository, pending = false }) {
  assert(stableTag.test(tag), 'Invalid release tag');
  const file = path.join(directory, manifestName);
  await verifyChecksum(file);
  const manifest = readJson(file);
  const version = v8Version(root);
  validateManifest(manifest, repository, tag, localFingerprint(root), version);
  assert.equal(manifest.releaseCommit, run('git', ['rev-parse', 'HEAD'], root).trim(), 'Release commit mismatch');
  assert.equal(manifest.validationFingerprint, localFingerprint(root, 'validation'), 'Validation scripts changed');
  if (!pending) validateReceipts(manifest, manifest.validations);
  const expected = [manifestName, `${manifestName}.sha256`,
    ...manifest.assets.flatMap(asset => [asset.name, `${asset.name}.sha256`])];
  const actual = readdirSync(directory).filter(name => name.startsWith('star-v8-') || name.startsWith('v8-'));
  assert.deepEqual(actual.sort(), expected.sort(), 'Unexpected or missing V8 assets');
  await withTemp(async work => {
    for (const asset of manifest.assets) {
      const sha256 = await validateV8Archive(path.join(directory, asset.name), asset.triplet,
        version, manifest.origin.headSha, path.join(work, asset.triplet));
      assert.equal(sha256, asset.sha256, 'V8 provenance checksum mismatch');
    }
  });
  return manifest;
}

export async function finalizeV8({ root, directory, tag, repository, receipts }) {
  const manifest = await verifyV8Set({ root, directory, tag, repository, pending: true });
  assertNames(receipts, triplets.map(triplet => `${triplet}.json`));
  manifest.validations = triplets.map(triplet => readJson(path.join(receipts, `${triplet}.json`)));
  validateReceipts(manifest, manifest.validations);
  await writeManifest(directory, manifest);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, directory, receipts] = process.argv.slice(2);
    const root = process.cwd();
    const tag = process.env.RELEASE_TAG;
    const repository = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
    if (mode === 'check-config') validateSource(readJson(path.join(root, 'v8-release.json')), tag);
    else if (mode === 'prepare' && directory) await prepareV8({ root, output: path.resolve(directory), tag,
      config: readJson(path.join(root, 'v8-release.json')), client: new GitHub(repository) });
    else if (mode === 'verify' && directory) await verifyV8Set({ root, directory: path.resolve(directory), tag, repository });
    else if (mode === 'finalize' && directory && receipts) await finalizeV8({ root,
      directory: path.resolve(directory), tag, repository, receipts: path.resolve(receipts) });
    else throw new Error('Usage: node scripts/release/prepare-v8.mjs check-config | prepare <directory> | finalize <directory> <receipts> | verify <directory>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
