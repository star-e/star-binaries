import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, archiveName, extractSelected, fingerprint, hashFile, linkage, localFingerprint,
  manifestName, readJson, run, triplets, v8Version, validateSource, validateV8Archive, verifyChecksum, withTemp } from '../../scripts/release/common.mjs';
import { prepareV8, validateRun, verifyV8Set } from '../../scripts/release/prepare-v8.mjs';
import { uploadAssets } from '../../scripts/release/upload-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repository = 'star-e/star-binaries';
const sourceSha = run('git', ['rev-parse', 'HEAD'], root).trim();
const tree = run('git', ['ls-tree', '-r', '--full-tree', 'HEAD'], root).trim().split('\n').map(line => {
  const [meta, name] = line.split('\t');
  const [mode, type, sha] = meta.split(' ');
  return { mode, type, sha, path: name };
});
const version = v8Version(root);
const config = { schemaVersion: 1, source: 'workflow', runId: 123 };
const runInfo = { id: 123, path: '.github/workflows/v8.yml', event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', head_sha: sourceSha, head_repository: { full_name: repository } };

function write(file, content = 'fixture') {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}
async function sidecar(file) { write(`${file}.sha256`, `${await hashFile(file)}  ${path.basename(file)}\n`); }

test('GitHub downloads use endpoint-specific Accept headers and preserve binary bytes', async () => withTemp(async work => {
  const client = new GitHub(repository);
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x80]);
  const calls = [];
  const spawn = mock.method(childProcess, 'spawnSync', (command, args, options) => {
    assert.equal(command, 'gh');
    calls.push(args);
    // Model the bytes received after gh follows the download redirect.
    writeFileSync(options.stdio[1], bytes);
    return { status: 0 };
  });
  syncBuiltinESMExports();
  try {
    const artifact = path.join(work, 'artifact.zip');
    const asset = path.join(work, 'asset.zip');
    client.download('actions/artifacts/123/zip', artifact);
    client.downloadReleaseAsset({ id: 456, state: 'uploaded' }, asset);
    assert.deepEqual(calls, [
      ['api', '-H', 'Accept: application/vnd.github+json', `repos/${repository}/actions/artifacts/123/zip`],
      ['api', '-H', 'Accept: application/octet-stream', `repos/${repository}/releases/assets/456`]
    ]);
    assert.deepEqual(readFileSync(artifact), bytes);
    assert.deepEqual(readFileSync(asset), bytes);
  } finally {
    spawn.mock.restore();
    syncBuiltinESMExports();
  }
}));

async function fixture(work) {
  const artifacts = [], downloads = new Map();
  for (const [index, triplet] of triplets.entries()) {
    const name = archiveName(version.version, triplet);
    const directory = path.join(work, triplet);
    const base = path.basename(name, '.zip');
    const sdk = path.join(directory, base);
    write(path.join(sdk, 'provenance/identity.txt'), Object.entries({ source: sourceSha,
      v8: version.revision, depot_tools: version.depot, triplet, linkage: linkage(triplet),
      pointer_compression: 'true', sandbox: 'true' }).map(([key, value]) => `${key}=${value}\n`).join(''));
    write(path.join(sdk, 'share/v8/V8Config.cmake'));
    write(path.join(sdk, 'share/v8/V8ConfigVersion.cmake'));
    for (const configuration of ['Release', 'Debug']) {
      const configName = configuration.toLowerCase();
      write(path.join(sdk, `provenance/build-${configName}.txt`), `configuration=${configuration}\n`);
      write(path.join(sdk, `provenance/${configName}-args.gn`));
      write(path.join(sdk, `${configName}/include/v8-gn.h`));
      const libraryRoot = configuration === 'Debug' ? path.join(sdk, 'debug') : sdk;
      if (linkage(triplet) === 'static') write(path.join(libraryRoot, 'lib/libv8_monolith.a'));
      else {
        for (const component of ['v8', 'v8_libplatform', 'v8_libbase']) {
          if (triplet.includes('windows')) {
            write(path.join(libraryRoot, `bin/${component}.dll`));
            write(path.join(libraryRoot, `lib/${component}.dll.lib`));
          } else write(path.join(libraryRoot, `lib/lib${component}.${triplet.includes('osx') ? 'dylib' : 'cr.so'}`));
        }
        if (triplet.includes('android')) write(path.join(libraryRoot, 'lib/libc++_shared.so'));
      }
    }
    run('cmake', ['-E', 'tar', 'cf', name, '--format=zip', base], directory);
    await sidecar(path.join(directory, name));
    const envelope = path.join(directory, 'artifact.zip');
    run('cmake', ['-E', 'tar', 'cf', envelope, '--format=zip', name, `${name}.sha256`], directory);
    artifacts.push({ id: index + 1, name: `v8-${triplet}-sdk`, expired: false,
      workflow_run: { head_sha: sourceSha }, digest: `sha256:${await hashFile(envelope)}` });
    downloads.set(`actions/artifacts/${index + 1}/zip`, envelope);
  }
  return {
    repository, artifacts, downloads, runInfo: structuredClone(runInfo), sourceTree: structuredClone(tree),
    api(route) {
      assert.equal(route, 'actions/runs/123');
      return this.runInfo;
    },
    tree() { return this.sourceTree; },
    pages(route) { assert.equal(route, 'actions/runs/123/artifacts'); return this.artifacts; },
    download(route, file) { copyFileSync(this.downloads.get(route), file); }
  };
}

test('explicit source required; no self-reuse or ambiguous config', () => {
  assert.throws(() => validateSource({ schemaVersion: 1, source: null }, 'v0.1.4'), /Configure v8-release/);
  assert.throws(() => validateSource({ ...config, runId: 0 }, 'v0.1.4'), /positive/);
  assert.throws(() => validateSource({ schemaVersion: 1, source: 'release', tag: 'v0.1.4' }, 'v0.1.4'), /different/);
  assert.throws(() => validateSource({ ...config, tag: 'v0.1.3' }, 'v0.1.4'));
  assert.equal(validateSource(config, 'v0.1.4'), config);
});

test('fingerprint ignores ordinary dependency updates but includes V8 inputs', () => {
  assert.equal(fingerprint(tree), localFingerprint(root));
  const changed = structuredClone(tree);
  changed.find(entry => entry.path === 'vcpkg.json').sha = 'a'.repeat(40);
  assert.equal(fingerprint(changed), fingerprint(tree));
  changed.find(entry => entry.path === 'scripts/v8/args.cmake').sha = 'b'.repeat(40);
  assert.notEqual(fingerprint(changed), fingerprint(tree));
  assert.throws(() => fingerprint(tree.filter(entry => entry.path !== 'v8-version.cmake')), /Missing/);
});

test('reject failed, incomplete, fork, and wrong workflow runs', () => {
  for (const change of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' },
    { path: '.github/workflows/build.yml' }, { head_repository: { full_name: 'fork/repo' } }]) {
    assert.throws(() => validateRun({ ...runInfo, ...change }, 123, repository));
  }
  assert.deepEqual(validateRun(runInfo, 123, repository), { runId: 123, headSha: sourceSha });
});

test('prepare all six workflow SDKs, verify, then reuse release bytes and origin', async () => withTemp(async work => {
  const client = await fixture(work);
  const output = path.join(work, 'first');
  const manifest = await prepareV8({ root, output, tag: 'v0.1.4', config, client });
  assert.equal(readdirSync(output).length, 14);
  await verifyV8Set({ root, directory: output, tag: 'v0.1.4', repository });
  const releaseFiles = readdirSync(output).map((name, id) => ({ name, id: id + 1, state: 'uploaded' }));
  const releaseClient = { repository,
    api(route) { assert.equal(route, 'releases/tags/v0.1.4'); return { id: 40, tag_name: 'v0.1.4', draft: false, prerelease: false }; },
    pages(route) { assert.equal(route, 'releases/40/assets'); return releaseFiles; },
    downloadReleaseAsset(asset, file) { copyFileSync(path.join(output, asset.name), file); }
  };
  const reusedOutput = path.join(work, 'second');
  const reused = await prepareV8({ root, output: reusedOutput, tag: 'v0.1.5',
    config: { schemaVersion: 1, source: 'release', tag: 'v0.1.4' }, client: releaseClient });
  assert.deepEqual(reused.assets, manifest.assets);
  assert.deepEqual(reused.origin, manifest.origin);
  await verifyV8Set({ root, directory: reusedOutput, tag: 'v0.1.5', repository });
  for (const asset of reused.assets) assert.equal(await hashFile(path.join(output, asset.name)), await hashFile(path.join(reusedOutput, asset.name)));
  const metadata = readJson(path.join(reusedOutput, manifestName));
  metadata.assets[0].sha256 = '0'.repeat(64);
  write(path.join(reusedOutput, manifestName), JSON.stringify(metadata));
  await sidecar(path.join(reusedOutput, manifestName));
  await assert.rejects(verifyV8Set({ root, directory: reusedOutput, tag: 'v0.1.5', repository }), /provenance checksum/);
}));

test('preparation fails before downloads for missing/expired platforms and changed inputs', async () => withTemp(async work => {
  const client = await fixture(work);
  client.download = () => { throw new Error('Unexpected download'); };
  client.artifacts[0].expired = true;
  await assert.rejects(prepareV8({ root, output: path.join(work, 'expired'), tag: 'v0.1.4', config, client }), /Expired artifact/);
  client.artifacts.shift();
  await assert.rejects(prepareV8({ root, output: path.join(work, 'missing'), tag: 'v0.1.4', config, client }), /Missing or ambiguous/);
  client.sourceTree.find(entry => entry.path === 'v8-version.cmake').sha = 'a'.repeat(40);
  await assert.rejects(prepareV8({ root, output: path.join(work, 'changed'), tag: 'v0.1.4', config, client }), /inputs differ/);
}));

test('modified ZIP and incorrect checksum filename are rejected', async () => withTemp(async work => {
  const file = path.join(work, 'sdk.zip');
  write(file, 'original');
  await sidecar(file);
  write(file, 'modified');
  await assert.rejects(verifyChecksum(file), /Checksum mismatch/);
  write(`${file}.sha256`, `${await hashFile(file)}  another.zip\n`);
  await assert.rejects(verifyChecksum(file), /filename mismatch/);
}));

test('artifact wrapper rejects unexpected entries instead of extracting them', async () => withTemp(async work => {
  write(path.join(work, 'unexpected.txt'));
  const zip = path.join(work, 'wrapper.zip');
  run('cmake', ['-E', 'tar', 'cf', zip, '--format=zip', 'unexpected.txt'], work);
  assert.throws(() => extractSelected(zip, path.join(work, 'extract'), ['sdk.zip', 'sdk.zip.sha256']), /Unexpected archive entry/);
}));

test('SDK identity and Debug libraries are mandatory even with valid checksums', async () => withTemp(async work => {
  await fixture(work);
  const triplet = 'arm64-ios-star';
  const directory = path.join(work, triplet);
  const name = archiveName(version.version, triplet);
  const base = path.basename(name, '.zip');
  const archive = path.join(directory, name);
  await assert.rejects(validateV8Archive(archive, triplet, version, '0'.repeat(40), path.join(work, 'wrong-source')), /identity mismatch: source/);
  unlinkSync(path.join(directory, base, 'debug/lib/libv8_monolith.a'));
  run('cmake', ['-E', 'tar', 'cf', name, '--format=zip', base], directory);
  await sidecar(archive);
  await assert.rejects(validateV8Archive(archive, triplet, version, sourceSha, path.join(work, 'missing-debug')), /Missing V8 library/);
}));

test('upload retries skip identical assets; conflicts prevent every write', async () => withTemp(async work => {
  const directory = path.join(work, 'assets');
  const file = path.join(directory, 'sdk.zip');
  write(file, 'binary');
  await sidecar(file);
  let uploads = [];
  const client = {
    api() { return { id: 4, tag_name: 'v0.1.4', draft: false, prerelease: false }; },
    remote: [{ id: 1, name: 'sdk.zip', state: 'uploaded', digest: `sha256:${await hashFile(file)}` }],
    pages() { return this.remote; },
    downloadReleaseAsset(asset, destination) { copyFileSync(path.join(directory, asset.name), destination); },
    upload(tag, upload) { assert.equal(tag, 'v0.1.4'); uploads.push(path.basename(upload)); }
  };
  await uploadAssets({ client, directory, tag: 'v0.1.4' });
  assert.deepEqual(uploads, ['sdk.zip.sha256']);
  uploads = [];
  client.remote.push({ id: 2, name: 'sdk.zip.sha256', state: 'uploaded' });
  await uploadAssets({ client, directory, tag: 'v0.1.4' });
  assert.deepEqual(uploads, []);
  client.remote = [{ id: 3, name: 'sdk.zip.sha256', state: 'uploaded', digest: `sha256:${'0'.repeat(64)}` }];
  await assert.rejects(uploadAssets({ client, directory, tag: 'v0.1.4' }), /Published asset differs/);
  assert.deepEqual(uploads, []);
}));
