import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, readJson, run, withTemp } from '../../scripts/release/common.mjs';
import { localSdkFingerprint, prepareSdk, recordSdkBuild, sdkBuildManifestName, sdkFingerprint,
  sdkManifestName, sdkPackages, validateSdkArchive, verifySdkSet } from '../../scripts/release/prepare-sdk.mjs';
import { uploadAssets } from '../../scripts/release/upload-assets.mjs';
import { recordReleaseSet, releaseManifestName, verifyReleaseSet } from '../../scripts/release/release-set.mjs';
import { otherFamilies } from './package-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'star-e/star-binaries', runId = 321;
const headSha = run('git', ['rev-parse', 'HEAD'], root).trim();
const baseline = readJson(path.join(root, 'vcpkg.json'))['builtin-baseline'];
const tree = run('git', ['ls-tree', '-r', '--full-tree', 'HEAD'], root).trim().split('\n').map(line => {
  const [meta, name] = line.split('\t'), [mode, type, sha] = meta.split(' ');
  return { mode, type, sha, path: name };
});
const config = { schemaVersion: 1, source: 'workflow', runId };

function write(file, contents = 'fixture') { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, contents); }
async function sidecar(file) { write(`${file}.sha256`, `${await hashFile(file)}  ${path.basename(file)}\n`); }

async function fixture(work) {
  const directory = path.join(work, 'packages');
  for (const item of sdkPackages()) {
    // Include symbols on Windows, omit them on macOS, as actual builds can do.
    if (item.optional && item.triplet === 'arm64-osx-star') continue;
    const base = path.basename(item.name, '.zip');
    const stage = path.join(work, 'stage', base);
    write(path.join(stage, 'provenance/build.txt'), `source=${headSha}\nvcpkg=${baseline}\ntriplet=${item.triplet}\nconfigurations=Release,Debug\n`);
    if (item.kind === 'sdk') {
      write(path.join(stage, 'include/boost/container/vector.hpp'));
      for (const prefix of ['lib', 'debug/lib']) write(path.join(stage, prefix, 'libboost_container.a'));
    } else {
      write(path.join(stage, 'provenance/configuration.txt'), item.configurations[0]);
      write(path.join(stage, 'lib', item.kind.endsWith('-symbols') ? 'boost_container.pdb' : 'boost_container.dylib'));
    }
    mkdirSync(directory, { recursive: true });
    const archive = path.join(directory, item.name);
    run('cmake', ['-E', 'tar', 'cf', archive, '--format=zip', base], path.dirname(stage));
    await sidecar(archive);
  }
  return directory;
}

test('SDK inputs cover its vcpkg gitlink, overlays, toolchains and consumers only', () => {
  assert.equal(localSdkFingerprint(root), sdkFingerprint(tree));
  for (const name of ['tools/vcpkg', 'vcpkg.json', 'triplets/x64-windows-star.cmake', 'tests/consumer/main.cpp']) {
    assert.notEqual(sdkFingerprint(tree.map(item => item.path === name ? { ...item, sha: 'b'.repeat(40) } : item)), sdkFingerprint(tree));
  }
  for (const name of ['dotnet-version.cmake', 'v8-version.cmake', 'release-inputs.json', 'README.md']) {
    assert.equal(sdkFingerprint(tree.map(item => item.path === name ? { ...item, sha: 'b'.repeat(40) } : item)), sdkFingerprint(tree));
  }
});

test('SDK build inventory rejects missing platforms and unexpected files', async () => withTemp(async work => {
  const directory = await fixture(work);
  const options = { root, directory, repository, runId };
  const file = path.join(directory, 'star-binaries-arm64-ios-star-sdk.zip');
  const bytes = readFileSync(file);
  unlinkSync(file);
  await assert.rejects(recordSdkBuild(options));
  writeFileSync(file, bytes);
  write(path.join(directory, 'unrelated.zip'));
  await assert.rejects(recordSdkBuild(options), /Unexpected or missing assets/);
  unlinkSync(path.join(directory, 'unrelated.zip'));
  const manifest = await recordSdkBuild(options);
  assert.equal(manifest.assets.length, 12); // 10 required + two Windows symbol archives.
  assert.equal(manifest.assets.find(item => item.triplet === 'arm64-ios-star').validation, 'compile-link');
}));

test('SDK workflow collection, release reuse and upload preserve archives and exact origin', async () => withTemp(async work => {
  const directory = await fixture(work);
  const build = await recordSdkBuild({ root, directory, repository, runId });
  const envelope = path.join(work, 'artifact.zip');
  run('cmake', ['-E', 'tar', 'cf', envelope, '--format=zip', ...readdirSync(directory)], directory);
  const client = { repository,
    api: () => ({ id: runId, path: '.github/workflows/sdk.yml', status: 'completed', conclusion: 'success',
      event: 'workflow_dispatch', head_sha: headSha, head_repository: { full_name: repository } }),
    tree: () => tree,
    pages: () => [{ id: 1, name: 'sdk-packages', workflow_run: { head_sha: headSha } }],
    download: (route, file) => copyFileSync(envelope, file) };
  const first = path.join(work, 'first');
  const manifest = await prepareSdk({ root, output: first, config, client, tag: 'v0.1.6' });
  assert.deepEqual(manifest.origin, build.origin);
  await verifySdkSet({ root, directory: first, repository, tag: 'v0.1.6' });
  const second = path.join(work, 'second');
  const releaseClient = { repository, api: () => ({ id: 20, tag_name: 'v0.1.6', draft: false, prerelease: false }),
    pages: () => readdirSync(first).map(name => ({ name })),
    downloadReleaseAsset: (asset, file) => copyFileSync(path.join(first, asset.name), file) };
  await prepareSdk({ root, output: second, tag: 'v0.1.7', config: { schemaVersion: 1, source: 'release', tag: 'v0.1.6' }, client: releaseClient });
  await verifySdkSet({ root, directory: second, repository, tag: 'v0.1.7' });
  for (const asset of manifest.assets) assert.equal(await hashFile(path.join(first, asset.name)), await hashFile(path.join(second, asset.name)));
  const uploads = [];
  await uploadAssets({ directory: second, tag: 'v0.1.7', client: {
    api: () => ({ id: 21, tag_name: 'v0.1.7', draft: false, prerelease: false }), pages: () => [],
    upload: (tag, file) => uploads.push(path.basename(file)) } });
  assert(uploads.includes(sdkManifestName));
  const file = path.join(second, sdkManifestName);
  const changed = readJson(file);
  changed.assets[0].validation = 'compile-link';
  write(file, JSON.stringify(changed)); await sidecar(file);
  await assert.rejects(verifySdkSet({ root, directory: second, repository, tag: 'v0.1.7' }), /coverage mismatch/);
  await otherFamilies(root, path.join(work, 'families'), first, repository, 'v0.1.6');
  const options = { root, directory: first, repository, tag: 'v0.1.6' };
  const summary = await recordReleaseSet(options);
  assert.deepEqual(Object.keys(summary.packages), ['sdk', 'v8', 'dotnet']);
  assert.equal(summary.packages.sdk.origin.runId, runId);
  assert.equal(summary.packages.dotnet.origin.runId, 789);
  await verifyReleaseSet(options);
  const summaryFile = path.join(first, releaseManifestName);
  summary.packages.sdk.origin.runId++;
  write(summaryFile, JSON.stringify(summary)); await sidecar(summaryFile);
  await assert.rejects(verifyReleaseSet(options), /Release source summary mismatch/);
  write(path.join(first, 'unrelated.zip'));
  await assert.rejects(recordReleaseSet(options), /Unexpected or missing release assets/);
}));

test('SDK archives require origin identity and both library configurations', async () => withTemp(async work => {
  const directory = await fixture(work);
  const item = sdkPackages()[0], file = path.join(directory, item.name);
  await assert.rejects(validateSdkArchive(file, item, { headSha: 'b'.repeat(40) }, baseline, path.join(work, 'bad')), /identity mismatch: source/);
  const base = path.basename(item.name, '.zip'), stage = path.join(work, 'stage');
  unlinkSync(path.join(stage, base, 'debug/lib/libboost_container.a'));
  run('cmake', ['-E', 'tar', 'cf', file, '--format=zip', base], stage); await sidecar(file);
  await assert.rejects(validateSdkArchive(file, item, { headSha }, baseline, path.join(work, 'missing')), /Missing SDK library/);
}));
