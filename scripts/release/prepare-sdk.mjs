import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, assertNames, extractSelected, hashFile, hashPattern, readJson, run, shaPattern,
  stableTag, triplets, validateSource, verifyChecksum, withTemp } from './common.mjs';
import { oneAsset, readSource, selectBuildRun } from './sources.mjs';

export const sdkManifestName = 'sdk-provenance.json';
export const sdkBuildManifestName = 'sdk-build.json';
const isInput = name => ['.gitattributes', '.gitmodules', 'tools/vcpkg', 'vcpkg.json',
  'vcpkg-configuration.json', '.github/workflows/sdk.yml', 'scripts/build.cmake',
  'scripts/build-android.cmake', 'scripts/build-ios.cmake', 'scripts/ios-simulator-smoke.cmake',
  'scripts/shutdown-ios-simulator.ps1', 'scripts/release/prepare-sdk.mjs',
  'scripts/release/common.mjs', 'scripts/release/sources.mjs'].includes(name) ||
  ['ports/', 'triplets/', 'tests/consumer/', 'tests/android/', 'tests/ios/'].some(prefix => name.startsWith(prefix));

export function sdkFingerprint(tree) {
  const files = tree.filter(file => file.type !== 'tree' && isInput(file.path))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const name of ['vcpkg.json', 'vcpkg-configuration.json', 'tools/vcpkg', '.github/workflows/sdk.yml',
    'scripts/build.cmake', 'scripts/build-android.cmake', 'scripts/build-ios.cmake']) {
    assert(files.some(file => file.path === name), `Missing SDK input: ${name}`);
  }
  for (const file of files) {
    assert(shaPattern.test(file.sha) && (file.path === 'tools/vcpkg'
      ? file.type === 'commit' && file.mode === '160000'
      : file.type === 'blob' && /^100(644|755)$/.test(file.mode)), `Unsupported SDK input: ${file.path}`);
  }
  return createHash('sha256').update(files.map(file => `${file.mode} ${file.sha} ${file.path}\n`).join('')).digest('hex');
}

export function localSdkFingerprint(root) {
  const changed = run('git', ['diff', '--name-only', '-z', 'HEAD'], root).split('\0');
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0');
  assert(![...changed, ...untracked].some(isInput), 'Commit SDK inputs before preparing release assets');
  const tree = run('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean).map(line => {
    const [, mode, type, sha, name] = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    return { mode, type, sha, path: name };
  });
  return sdkFingerprint(tree);
}

export function sdkPackages() {
  return triplets.flatMap(triplet => {
    const desktop = ['x64-windows-star', 'arm64-osx-star'].includes(triplet);
    return ['sdk', ...(desktop ? ['release-runtime', 'debug-runtime', 'release-symbols', 'debug-symbols'] : [])]
      .map(kind => ({ triplet, kind, name: `star-binaries-${triplet}-${kind}.zip`,
        optional: kind.endsWith('-symbols'), configurations: kind === 'sdk' ? ['Release', 'Debug'] :
          [kind.startsWith('debug-') ? 'Debug' : 'Release'],
        validation: ['arm64-android-star', 'arm64-ios-star'].includes(triplet) ? 'compile-link' : 'runtime' }));
  });
}

function packageSet(assets) {
  const allowed = sdkPackages();
  assert(Array.isArray(assets), 'Missing SDK asset list');
  assert.equal(new Set(assets.map(item => item.name)).size, assets.length, 'Duplicate SDK asset');
  for (const item of allowed.filter(item => !item.optional)) oneAsset(assets, item.name);
  for (const asset of assets) {
    const item = oneAsset(allowed, asset.name);
    for (const key of ['triplet', 'kind', 'configurations', 'validation']) {
      assert.deepEqual(asset[key], item[key], `SDK coverage mismatch: ${key}`);
    }
    assert(hashPattern.test(asset.sha256), 'Invalid SDK checksum');
  }
}

export async function validateSdkArchive(file, item, origin, baseline, work) {
  const checksum = await verifyChecksum(file);
  const base = path.basename(item.name, '.zip');
  const metadata = [`${base}/provenance/build.txt`];
  if (item.kind !== 'sdk') metadata.push(`${base}/provenance/configuration.txt`);
  const entries = extractSelected(file, work, metadata, base);
  const build = readFileSync(path.join(work, metadata[0]), 'utf8').split(/\r?\n/);
  for (const [key, value] of Object.entries({ source: origin.headSha, vcpkg: baseline,
    triplet: item.triplet, configurations: 'Release,Debug' })) {
    assert.equal(build.filter(line => line.startsWith(`${key}=`)).join(), `${key}=${value}`, `SDK identity mismatch: ${key}`);
  }
  if (item.kind === 'sdk') {
    assert(entries.some(name => name.startsWith(`${base}/include/boost/`)), 'Missing SDK headers');
    for (const directory of ['lib/', 'debug/lib/']) {
      assert(entries.some(name => name.startsWith(`${base}/${directory}`) && /boost_container.*\.(lib|a|dylib)$/.test(name)),
        `Missing SDK library in ${directory}`);
    }
  } else {
    assert.equal(readFileSync(path.join(work, metadata[1]), 'utf8').trim(), item.configurations[0], 'Wrong SDK configuration');
    assert(entries.some(name => item.kind.endsWith('-runtime') ? /\.(dll|dylib)$/.test(name) : /\.pdb$|\.dSYM\//.test(name)),
      `Missing SDK ${item.kind} payload`);
  }
  return checksum;
}

async function writeManifest(directory, name, manifest) {
  const file = path.join(directory, name);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(`${file}.sha256`, `${await hashFile(file)}  ${name}\n`);
}

function validateManifest(manifest, repository, expectedFingerprint, baseline) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported SDK manifest');
  assert.equal(manifest.repository, repository, 'SDK repository mismatch');
  assert.equal(manifest.inputFingerprint, expectedFingerprint, 'SDK build/test inputs changed');
  assert.equal(manifest.vcpkgBaseline, baseline, 'vcpkg baseline changed');
  assert(shaPattern.test(manifest.origin?.headSha), 'Invalid SDK source commit');
  assert(Number.isSafeInteger(manifest.origin?.runId) && manifest.origin.runId > 0, 'Invalid SDK run ID');
  packageSet(manifest.assets);
}

// Called only after all six platform builds and consumers have succeeded.
export async function recordSdkBuild({ root, directory, repository, runId }) {
  const origin = { runId, headSha: run('git', ['rev-parse', 'HEAD'], root).trim() };
  const baseline = readJson(path.join(root, 'vcpkg.json'))['builtin-baseline'];
  const assets = [];
  await withTemp(async work => {
    for (const item of sdkPackages()) {
      const file = path.join(directory, item.name);
      if (item.optional && !existsSync(file)) continue;
      const sha256 = await validateSdkArchive(file, item, origin, baseline, path.join(work, item.name));
      const { optional, ...asset } = item;
      assets.push({ ...asset, sha256 });
    }
  });
  assertNames(directory, assets.flatMap(item => [item.name, `${item.name}.sha256`]));
  const manifest = { schemaVersion: 1, repository, origin, inputFingerprint: localSdkFingerprint(root),
    vcpkgBaseline: baseline, assets };
  validateManifest(manifest, repository, manifest.inputFingerprint, baseline);
  await writeManifest(directory, sdkBuildManifestName, manifest);
  return manifest;
}

export async function prepareSdk({ root, output, tag, config, client }) {
  validateSource(config, tag);
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Use an empty SDK output directory');
  const expectedFingerprint = localSdkFingerprint(root);
  const baseline = readJson(path.join(root, 'vcpkg.json'))['builtin-baseline'];
  mkdirSync(output, { recursive: true });
  return withTemp(async work => {
    let previous, origin;
    if (config.source === 'workflow') {
      const selected = selectBuildRun({ client, config, workflow: 'sdk.yml', fingerprint: sdkFingerprint,
        expectedFingerprint, artifacts: ['sdk-packages'] });
      origin = selected.origin;
      const artifact = oneAsset(selected.assets, 'sdk-packages');
      const envelope = path.join(work, 'sdk-artifact.zip');
      client.download(`actions/artifacts/${artifact.id}/zip`, envelope);
      if (artifact.digest) assert.equal(`sha256:${await hashFile(envelope)}`, artifact.digest, 'SDK artifact digest mismatch');
      const metadata = [sdkBuildManifestName, `${sdkBuildManifestName}.sha256`];
      const allowed = [...metadata, ...sdkPackages().flatMap(item => [item.name, `${item.name}.sha256`])];
      const names = run('cmake', ['-E', 'tar', 'tf', envelope]).trim().split(/\r?\n/);
      assert(names.every(name => allowed.includes(name)), 'Unexpected SDK artifact entry');
      extractSelected(envelope, work, names);
      await verifyChecksum(path.join(work, sdkBuildManifestName));
      previous = readJson(path.join(work, sdkBuildManifestName));
      validateManifest(previous, client.repository, expectedFingerprint, baseline);
      assert.deepEqual(previous.origin, origin, 'SDK artifact origin mismatch');
      assert.deepEqual(names.sort(), [...metadata, ...previous.assets.flatMap(item => [item.name, `${item.name}.sha256`])].sort(),
        'Incomplete SDK build artifact');
    } else {
      const release = client.api(`releases/tags/${config.tag}`);
      assert.equal(release.tag_name, config.tag);
      assert(!release.draft && !release.prerelease, 'Reuse requires a published stable release');
      const assets = client.pages(`releases/${release.id}/assets`);
      for (const name of [sdkManifestName, `${sdkManifestName}.sha256`]) {
        client.downloadReleaseAsset(oneAsset(assets, name), path.join(work, name));
      }
      await verifyChecksum(path.join(work, sdkManifestName));
      previous = readJson(path.join(work, sdkManifestName));
      validateManifest(previous, client.repository, expectedFingerprint, baseline);
      assert.equal(previous.releaseTag, config.tag, 'SDK provenance belongs to another release');
      origin = previous.origin;
      for (const asset of previous.assets) {
        for (const name of [asset.name, `${asset.name}.sha256`]) {
          client.downloadReleaseAsset(oneAsset(assets, name), path.join(work, name));
        }
      }
    }
    for (const asset of previous.assets) {
      const checksum = await validateSdkArchive(path.join(work, asset.name), asset, origin, baseline, path.join(work, asset.name + '-metadata'));
      assert.equal(checksum, asset.sha256, 'SDK provenance checksum mismatch');
      for (const name of [asset.name, `${asset.name}.sha256`]) copyFileSync(path.join(work, name), path.join(output, name));
    }
    const manifest = { ...previous, releaseTag: tag, releaseCommit: run('git', ['rev-parse', 'HEAD'], root).trim(),
      source: config.source === 'workflow' ? { ...config, runId: origin.runId } : config };
    await writeManifest(output, sdkManifestName, manifest);
    return manifest;
  });
}

export async function verifySdkSet({ root, directory, tag, repository }) {
  assert(stableTag.test(tag), 'Invalid release tag');
  const file = path.join(directory, sdkManifestName);
  await verifyChecksum(file);
  const manifest = readJson(file);
  const baseline = readJson(path.join(root, 'vcpkg.json'))['builtin-baseline'];
  validateManifest(manifest, repository, localSdkFingerprint(root), baseline);
  assert.equal(manifest.releaseTag, tag, 'SDK provenance belongs to another release');
  assert.equal(manifest.releaseCommit, run('git', ['rev-parse', 'HEAD'], root).trim(), 'SDK release commit mismatch');
  const names = readdirSync(directory).filter(name => name.startsWith('star-binaries-') || name.startsWith('sdk-'));
  assert.deepEqual(names.sort(), [sdkManifestName, `${sdkManifestName}.sha256`,
    ...manifest.assets.flatMap(item => [item.name, `${item.name}.sha256`])].sort(), 'Unexpected or missing SDK assets');
  await withTemp(async work => {
    for (const asset of manifest.assets) {
      assert.equal(await validateSdkArchive(path.join(directory, asset.name), asset, manifest.origin, baseline,
        path.join(work, asset.name)), asset.sha256, 'SDK provenance checksum mismatch');
    }
  });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, directory] = process.argv.slice(2);
    const root = process.cwd(), tag = process.env.RELEASE_TAG;
    const repository = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
    if (mode === 'check-config') readSource(root, 'sdk', tag);
    else if (mode === 'record' && directory) await recordSdkBuild({ root, directory: path.resolve(directory),
      repository, runId: Number(process.env.GITHUB_RUN_ID) });
    else if (mode === 'prepare' && directory) await prepareSdk({ root, output: path.resolve(directory), tag,
      config: readSource(root, 'sdk', tag), client: new GitHub(repository) });
    else if (mode === 'verify' && directory) await verifySdkSet({ root, directory: path.resolve(directory), tag, repository });
    else throw new Error('Usage: node scripts/release/prepare-sdk.mjs check-config | record <directory> | prepare <directory> | verify <directory>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
