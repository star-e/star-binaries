import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, readJson, run, withTemp } from '../../scripts/release/common.mjs';
import { dotnetFingerprint, dotnetManifestName, dotnetPackages, dotnetVersion, localDotnetFingerprint,
  prepareDotnet, selectDotnetRun, validateDotnetArchive, validateDotnetRun, validateDotnetSource,
  verifyDotnetSet } from '../../scripts/release/prepare-dotnet.mjs';
import { uploadAssets } from '../../scripts/release/upload-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'star-e/star-binaries';
const sourceSha = run('git', ['rev-parse', 'HEAD'], root).trim();
const tree = run('git', ['ls-tree', '-r', '--full-tree', 'HEAD'], root).trim().split('\n').map(line => {
  const [meta, name] = line.split('\t');
  const [mode, type, sha] = meta.split(' ');
  return { mode, type, sha, path: name };
});
const version = dotnetVersion(root), packages = dotnetPackages(version);
const config = { schemaVersion: 1, source: 'workflow', runId: 'latest' };
const runInfo = { id: 123, run_number: 123, path: '.github/workflows/dotnet.yml', event: 'push',
  status: 'completed', conclusion: 'success', head_sha: sourceSha, head_repository: { full_name: repository } };

function write(file, content = 'fixture') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
async function sidecar(file) { write(`${file}.sha256`, `${await hashFile(file)}  ${path.basename(file)}\n`); }

async function createPackage(work, item, edit = build => build) {
  const stage = path.join(work, item.artifact), sdk = path.join(stage, item.base);
  const files = { 'LICENSE.TXT': 'fixture', 'THIRD-PARTY-NOTICES.TXT': 'fixture' };
  const build = { schemaVersion: 1, upstreamVersion: version.version, sourceTag: version.sourceTag,
    sourceRevision: version.revision, runtimeVersion: version.runtimeVersion, triplet: item.triplet, configuration: 'Release' };
  if (item.profile === 'mobile') {
    const rid = { 'arm64-android-star': 'android-arm64', 'x64-android-star': 'android-x64',
      'arm64-ios-star': 'ios-arm64', 'arm64-ios-simulator-star': 'iossimulator-arm64' }[item.triplet];
    Object.assign(build, { rid, runtimeFlavor: 'CoreCLR', artifactKind: 'runtime-pack', runtimeTested: false,
      validation: 'package-content-and-native-target', executionMode: rid.startsWith('android-') ? 'JIT+ReadyToRun' : 'Interpreter+ReadyToRun' });
    files[`packs/Microsoft.NETCore.App.Runtime.${rid}.${version.runtimeVersion}.nupkg`] = 'already checked by source workflow';
    files['include/coreclrhost.h'] = 'fixture';
  } else {
    Object.assign(build, { consumerSdk: version.consumerSdk });
    files[`runtime/shared/Microsoft.NETCore.App/${version.runtimeVersion}/System.Private.CoreLib.dll`] = 'fixture';
    files['include/hostfxr.h'] = 'fixture';
    files['share/dotnet/StarDotNetConfig.cmake'] = 'fixture';
    if (item.profile === 'base') {
      build.profile = 'base';
      const profile = readFileSync(path.join(root, 'scripts/dotnet/profiles/base.json'), 'utf8')
        .replace(/\r?\n/g, item.triplet === 'x64-windows-star' ? '\r\n' : '\n');
      build.profileSha256 = createHash('sha256').update(profile).digest('hex');
      files['provenance/profile.json'] = profile;
    }
  }
  files['provenance/build.json'] = JSON.stringify(edit(build));
  for (const [name, content] of Object.entries(files)) write(path.join(sdk, name), content);
  const hashes = await Promise.all(Object.keys(files).sort().map(async name => `${await hashFile(path.join(sdk, name))}  ${name}\n`));
  write(path.join(sdk, 'provenance/files.sha256'), hashes.join(''));
  const archive = path.join(stage, item.name);
  run('cmake', ['-E', 'tar', item.name.endsWith('.zip') ? 'cf' : 'czf', archive,
    item.name.endsWith('.zip') ? '--format=zip' : '--format=gnutar', item.base], stage);
  await sidecar(archive);
  return archive;
}

async function fixtureClient(work) {
  const envelopes = new Map(), artifacts = [];
  for (const [index, item] of packages.entries()) {
    const archive = await createPackage(work, item);
    const envelope = path.join(work, `${item.artifact}.zip`);
    run('cmake', ['-E', 'tar', 'cf', envelope, '--format=zip', item.name, `${item.name}.sha256`], path.dirname(archive));
    artifacts.push({ id: index + 1, name: item.artifact, expired: false, workflow_run: { head_sha: sourceSha },
      digest: `sha256:${await hashFile(envelope)}` });
    envelopes.set(`actions/artifacts/${index + 1}/zip`, envelope);
  }
  return { repository, artifacts,
    api(route) { assert.equal(route, 'actions/runs/123'); return runInfo; },
    tree(sha) { assert.equal(sha, sourceSha); return tree; },
    pages(route, key) {
      if (key === 'workflow_runs') return [runInfo];
      assert.equal(route, 'actions/runs/123/artifacts'); return artifacts;
    },
    download(route, file) { assert(envelopes.has(route)); copyFileSync(envelopes.get(route), file); }
  };
}

test('CoreCLR sources, package matrix and fingerprints are explicit', () => {
  validateDotnetSource(config, 'v0.1.6');
  validateDotnetSource({ ...config, runId: 123 }, 'v0.1.6');
  validateDotnetSource({ schemaVersion: 1, source: 'release', tag: 'v0.1.5' }, 'v0.1.6');
  assert.throws(() => validateDotnetSource({ ...config, runId: 0 }, 'v0.1.6'));
  assert.throws(() => validateDotnetSource({ schemaVersion: 1, source: 'release', tag: 'v0.1.6' }, 'v0.1.6'));
  assert.equal(packages.length, 8);
  assert.equal(packages.filter(item => item.runtimeTested).length, 4);
  assert.equal(packages.filter(item => item.name.endsWith('.tar.gz')).length, 6);
  assert.equal(dotnetFingerprint(tree), localDotnetFingerprint(root));
  assert.equal(dotnetFingerprint([...tree, { path: 'docs/new.md', type: 'blob', sha: 'a'.repeat(40), mode: '100644' }]), dotnetFingerprint(tree));
  assert.notEqual(dotnetFingerprint(tree.map(entry => entry.path === 'tests/dotnet/Smoke.cs' ? { ...entry, sha: 'b'.repeat(40) } : entry)), dotnetFingerprint(tree));
});

test('CoreCLR source rejects failures, forks, other workflows and incomplete builds', () => {
  assert.deepEqual(validateDotnetRun(runInfo, repository), { runId: 123, headSha: sourceSha });
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { path: '.github/workflows/v8.yml' },
    { event: 'pull_request' }, { head_repository: { full_name: 'fork/star-binaries' } }]) {
    assert.throws(() => validateDotnetRun({ ...runInfo, ...change }, repository));
  }
  const artifacts = packages.map((item, index) => ({ id: index + 1, name: item.artifact, workflow_run: { head_sha: sourceSha } }));
  const client = { repository, api: () => runInfo, tree: () => tree, pages: () => artifacts };
  assert.equal(selectDotnetRun(client, { ...config, runId: 123 }, dotnetFingerprint(tree), packages).origin.runId, 123);
  artifacts[0].expired = true;
  assert.throws(() => selectDotnetRun(client, { ...config, runId: 123 }, dotnetFingerprint(tree), packages), /Expired/);
  artifacts.shift();
  assert.throws(() => selectDotnetRun(client, { ...config, runId: 123 }, dotnetFingerprint(tree), packages), /Missing or ambiguous/);
});

test('automatic selection skips incompatible runs and reports absence of usable artifacts', () => {
  const artifacts = packages.map((item, index) => ({ id: index + 1, name: item.artifact, workflow_run: { head_sha: sourceSha } }));
  const client = { repository, tree: sha => sha === sourceSha ? tree : tree.filter(entry => entry.path !== 'dotnet-version.cmake'),
    pages: (route, key) => key === 'workflow_runs' ? [{ ...runInfo, id: 124, run_number: 124, head_sha: 'a'.repeat(40) }, runInfo] : artifacts };
  assert.equal(selectDotnetRun(client, config, dotnetFingerprint(tree), packages).origin.runId, 123);
  artifacts[0].expired = true;
  assert.throws(() => selectDotnetRun(client, config, dotnetFingerprint(tree), packages), /No complete matching/);
});

test('prepare, verify and reuse a complete CoreCLR release without modifying archives', async () => withTemp(async work => {
  const client = await fixtureClient(work);
  const output = path.join(work, 'prepared');
  const manifest = await prepareDotnet({ root, output, tag: 'v0.1.6', config, client });
  assert.equal(manifest.assets.length, 8);
  await verifyDotnetSet({ root, directory: output, tag: 'v0.1.6', repository });
  const sourceAssets = readdirSync(output).map((name, index) => ({ id: index + 1, name, state: 'uploaded' }));
  const reused = path.join(work, 'reused');
  await prepareDotnet({ root, output: reused, tag: 'v0.1.7', config: { schemaVersion: 1, source: 'release', tag: 'v0.1.6' },
    client: { repository, api: () => ({ id: 10, tag_name: 'v0.1.6', draft: false, prerelease: false }),
      pages: () => sourceAssets, downloadReleaseAsset: (asset, file) => copyFileSync(path.join(output, asset.name), file) } });
  await verifyDotnetSet({ root, directory: reused, tag: 'v0.1.7', repository });
  for (const item of packages) assert.equal(await hashFile(path.join(output, item.name)), await hashFile(path.join(reused, item.name)));
  // Even with an updated sidecar, the release verifier must reject false coverage.
  const metadata = path.join(output, dotnetManifestName);
  manifest.assets.find(item => item.profile === 'mobile').runtimeTested = true;
  write(metadata, JSON.stringify(manifest)); await sidecar(metadata);
  await assert.rejects(verifyDotnetSet({ root, directory: output, tag: 'v0.1.6', repository }), /runtimeTested/);
}));

test('archive checks reject a wrong upstream revision or inflated mobile validation', async () => withTemp(async work => {
  for (const [index, edit] of [build => ({ ...build, sourceRevision: 'f'.repeat(40) }),
    build => ({ ...build, runtimeTested: true })].entries()) {
    const item = packages.find(item => item.profile === 'mobile');
    const archive = await createPackage(path.join(work, String(index)), item, edit);
    await assert.rejects(validateDotnetArchive(root, archive, item, version, path.join(work, `checked-${index}`)),
      /identity mismatch|must not be overstated/);
  }
}));

test('CoreCLR tar.gz and provenance uploads are idempotent and conflict-checked', async () => withTemp(async directory => {
  const name = packages.find(item => item.profile === 'mobile').name;
  write(path.join(directory, name)); await sidecar(path.join(directory, name));
  write(path.join(directory, dotnetManifestName), '{}'); await sidecar(path.join(directory, dotnetManifestName));
  const remote = [], uploaded = [];
  const client = { api: () => ({ id: 1, tag_name: 'v0.1.6', draft: false, prerelease: false }), pages: () => remote,
    upload: (tag, file) => uploaded.push(path.basename(file)) };
  await uploadAssets({ client, directory, tag: 'v0.1.6' });
  assert.equal(uploaded.length, 4);
  for (const file of uploaded) remote.push({ name: file, state: 'uploaded', digest: `sha256:${await hashFile(path.join(directory, file))}` });
  uploaded.length = 0;
  await uploadAssets({ client, directory, tag: 'v0.1.6' }); assert.equal(uploaded.length, 0);
  remote[0].digest = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(uploadAssets({ client, directory, tag: 'v0.1.6' }), /Published asset differs/);
  assert.equal(uploaded.length, 0);
}));
