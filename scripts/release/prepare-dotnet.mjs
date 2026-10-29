import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, assertNames, extractSelected, hashFile, hashPattern, readJson, run,
  shaPattern, stableTag, triplets, validateSource, verifyChecksum, withTemp } from './common.mjs';
import { oneAsset, readSource, selectBuildRun, validateBuildRun } from './sources.mjs';

export const dotnetManifestName = 'dotnet-provenance.json';
const isInput = name => ['.gitattributes', 'dotnet-version.cmake', 'scripts/build-dotnet.cmake',
  'scripts/package-dotnet.cmake', '.github/workflows/dotnet.yml'].includes(name) ||
  ['scripts/dotnet/', 'tests/dotnet/'].some(prefix => name.startsWith(prefix));

export function dotnetFingerprint(tree) {
  const files = tree.filter(file => file.type !== 'tree' && isInput(file.path))
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const required of ['dotnet-version.cmake', 'scripts/build-dotnet.cmake',
    'scripts/package-dotnet.cmake', '.github/workflows/dotnet.yml']) {
    assert(files.some(file => file.path === required), `Missing CoreCLR input: ${required}`);
  }
  for (const file of files) {
    assert(file.type === 'blob' && /^100(644|755)$/.test(file.mode) && shaPattern.test(file.sha),
      `Unsupported CoreCLR input: ${file.path}`);
  }
  return createHash('sha256').update(files.map(file => `${file.mode} ${file.sha} ${file.path}\n`).join('')).digest('hex');
}

export function localDotnetFingerprint(root) {
  const modified = run('git', ['diff', '--name-only', '-z', 'HEAD'], root).split('\0');
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0');
  assert(![...modified, ...untracked].some(isInput), 'Commit CoreCLR input changes before preparing release assets');
  const tree = run('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean).map(line => {
    const [, mode, type, sha, name] = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(line);
    return { mode, type, sha, path: name };
  });
  return dotnetFingerprint(tree);
}

export function dotnetVersion(root) {
  const text = readFileSync(path.join(root, 'dotnet-version.cmake'), 'utf8');
  const get = key => {
    const match = text.match(new RegExp(`set\\(${key} "([^"]+)"\\)`));
    assert(match, `Missing ${key}`);
    return match[1];
  };
  const version = get('STAR_DOTNET_VERSION');
  const revision = get('STAR_DOTNET_REVISION');
  const runtimeVersion = get('STAR_DOTNET_RUNTIME_VERSION')
    .replace('${STAR_DOTNET_VERSION_SUFFIX}', get('STAR_DOTNET_VERSION_SUFFIX'));
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(version), 'Invalid CoreCLR version');
  assert(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$/.test(runtimeVersion), 'Invalid runtime version');
  assert(shaPattern.test(revision), 'Invalid CoreCLR source revision');
  return { version, revision, runtimeVersion, sourceTag: `v${version}`, consumerSdk: get('STAR_DOTNET_SDK_VERSION') };
}

export function dotnetPackages(version) {
  return triplets.flatMap(triplet => {
    const desktop = triplet === 'x64-windows-star' || triplet === 'arm64-osx-star';
    return (desktop ? ['full', 'base'] : ['mobile']).map(profile => {
      const suffix = { full: 'sdk', base: 'base-sdk', mobile: 'runtime-pack' }[profile];
      const extension = triplet === 'x64-windows-star' ? 'zip' : 'tar.gz';
      const base = `star-dotnet-${version.version}-${triplet}-release-${suffix}`;
      return { triplet, profile, base, name: `${base}.${extension}`,
        artifact: `dotnet-${triplet}-Release-${suffix}`, runtimeTested: desktop };
    });
  });
}

export const validateDotnetSource = validateSource;

export function validateDotnetRun(info, repository) {
  // Previously published push builds remain valid sources; new builds are manual.
  return validateBuildRun(info, repository, 'dotnet.yml', ['push', 'workflow_dispatch']);
}

export function selectDotnetRun(client, config, expectedFingerprint, packages) {
  return selectBuildRun({ client, config, expectedFingerprint, workflow: 'dotnet.yml',
    fingerprint: dotnetFingerprint, artifacts: packages.map(item => item.artifact),
    validate: info => validateDotnetRun(info, client.repository) });
}

export async function validateDotnetArchive(root, file, item, version, work) {
  const checksum = await verifyChecksum(file);
  const metadata = ['provenance/build.json', 'provenance/files.sha256'];
  if (item.profile === 'base') metadata.push('provenance/profile.json');
  const entries = extractSelected(file, work, metadata.map(name => `${item.base}/${name}`), item.base);
  const build = readJson(path.join(work, item.base, metadata[0]));
  for (const [key, value] of Object.entries({ schemaVersion: 1, upstreamVersion: version.version,
    sourceRevision: version.revision, sourceTag: version.sourceTag, runtimeVersion: version.runtimeVersion,
    triplet: item.triplet, configuration: 'Release' })) {
    assert.equal(build[key], value, `CoreCLR package identity mismatch: ${key}`);
  }
  const required = ['LICENSE.TXT', 'THIRD-PARTY-NOTICES.TXT'];
  if (item.profile === 'mobile') {
    const rid = { 'arm64-android-star': 'android-arm64', 'x64-android-star': 'android-x64',
      'arm64-ios-star': 'ios-arm64', 'arm64-ios-simulator-star': 'iossimulator-arm64' }[item.triplet];
    assert.equal(build.rid, rid);
    assert.equal(build.runtimeFlavor, 'CoreCLR');
    assert.equal(build.artifactKind, 'runtime-pack');
    assert.equal(build.validation, 'package-content-and-native-target');
    assert.equal(build.runtimeTested, false, 'Mobile runtime coverage must not be overstated');
    assert.equal(build.executionMode, rid.startsWith('android-') ? 'JIT+ReadyToRun' : 'Interpreter+ReadyToRun');
    required.push(`packs/Microsoft.NETCore.App.Runtime.${rid}.${version.runtimeVersion}.nupkg`, 'include/coreclrhost.h');
  } else {
    assert.equal(build.profile ?? 'full', item.profile, 'CoreCLR profile mismatch');
    assert.equal(build.consumerSdk, version.consumerSdk);
    required.push(`runtime/shared/Microsoft.NETCore.App/${version.runtimeVersion}/System.Private.CoreLib.dll`,
      'include/hostfxr.h', 'share/dotnet/StarDotNetConfig.cmake');
    if (item.profile === 'base') {
      const profile = path.join(work, item.base, 'provenance/profile.json');
      assert.equal(build.profileSha256, await hashFile(profile), 'Base profile checksum mismatch');
      // Preserve the archived bytes while allowing Git's Windows CRLF checkout.
      assert.deepEqual(readJson(profile), readJson(path.join(root, 'scripts/dotnet/profiles/base.json')), 'Base profile changed');
    }
  }
  for (const name of required) assert(entries.includes(`${item.base}/${name}`), `Incomplete CoreCLR package: ${name}`);
  // The source workflow already checked all payloads. Recheck extracted metadata
  // against its embedded checksums, in addition to the immutable outer archive.
  const checksums = readFileSync(path.join(work, item.base, 'provenance/files.sha256'), 'utf8').trim().split(/\r?\n/);
  for (const name of metadata.filter(name => name !== 'provenance/files.sha256')) {
    const expected = `${await hashFile(path.join(work, item.base, name))}  ${name}`;
    assert.equal(checksums.filter(line => line.endsWith(`  ${name}`)).join(), expected, `Metadata checksum mismatch: ${name}`);
  }
  return checksum;
}

function validateManifest(manifest, repository, tag, expectedFingerprint, version) {
  assert.equal(manifest.schemaVersion, 1, 'Unsupported CoreCLR provenance schema');
  assert.equal(manifest.repository, repository);
  assert.equal(manifest.releaseTag, tag, 'CoreCLR provenance belongs to another release');
  assert.equal(manifest.inputFingerprint, expectedFingerprint, 'CoreCLR build/package/test inputs changed');
  assert.deepEqual(manifest.dotnet, version, 'CoreCLR version pin changed');
  assert.equal(manifest.status, 'experimental');
  assert(shaPattern.test(manifest.origin?.headSha), 'Invalid CoreCLR origin commit');
  assert(Number.isSafeInteger(manifest.origin?.runId) && manifest.origin.runId > 0, 'Invalid CoreCLR origin run');
  const packages = dotnetPackages(version);
  assert.equal(manifest.assets?.length, packages.length, 'Incomplete CoreCLR package set');
  for (const [index, item] of packages.entries()) {
    const asset = manifest.assets[index];
    for (const key of ['triplet', 'profile', 'name', 'runtimeTested']) assert.equal(asset[key], item[key], `CoreCLR provenance mismatch: ${key}`);
    assert(hashPattern.test(asset.sha256), 'Invalid CoreCLR checksum');
  }
}

export async function prepareDotnet({ root, output, tag, config, client }) {
  validateDotnetSource(config, tag);
  assert(!existsSync(output) || readdirSync(output).length === 0, 'Use an empty CoreCLR output directory');
  const version = dotnetVersion(root);
  const expectedFingerprint = localDotnetFingerprint(root);
  const packages = dotnetPackages(version);
  mkdirSync(output, { recursive: true });
  return withTemp(async work => {
    let origin, sourceAssets, previous;
    if (config.source === 'workflow') {
      ({ origin, assets: sourceAssets } = selectDotnetRun(client, config, expectedFingerprint, packages));
    } else {
      const release = client.api(`releases/tags/${config.tag}`);
      assert.equal(release.tag_name, config.tag);
      assert(!release.draft && !release.prerelease, 'Reuse requires a published stable repository release');
      sourceAssets = client.pages(`releases/${release.id}/assets`);
      for (const name of [dotnetManifestName, `${dotnetManifestName}.sha256`]) {
        client.downloadReleaseAsset(oneAsset(sourceAssets, name), path.join(work, name));
      }
      await verifyChecksum(path.join(work, dotnetManifestName));
      previous = readJson(path.join(work, dotnetManifestName));
      validateManifest(previous, client.repository, config.tag, expectedFingerprint, version);
      origin = previous.origin;
    }
    const assets = [];
    for (const item of packages) {
      const input = path.join(work, item.triplet, item.profile);
      mkdirSync(input, { recursive: true });
      if (config.source === 'workflow') {
        const artifact = oneAsset(sourceAssets, item.artifact);
        const envelope = path.join(work, `${item.artifact}.zip`);
        client.download(`actions/artifacts/${artifact.id}/zip`, envelope);
        if (artifact.digest) assert.equal(`sha256:${await hashFile(envelope)}`, artifact.digest, 'CoreCLR artifact digest mismatch');
        extractSelected(envelope, input, [item.name, `${item.name}.sha256`]);
        unlinkSync(envelope);
      } else {
        for (const name of [item.name, `${item.name}.sha256`]) {
          client.downloadReleaseAsset(oneAsset(sourceAssets, name), path.join(input, name));
        }
      }
      assertNames(input, [item.name, `${item.name}.sha256`]);
      const sha256 = await validateDotnetArchive(root, path.join(input, item.name), item, version, path.join(input, 'metadata'));
      if (previous) assert.equal(sha256, previous.assets.find(asset => asset.name === item.name).sha256, 'Reused CoreCLR asset changed');
      assets.push({ triplet: item.triplet, profile: item.profile, name: item.name, sha256, runtimeTested: item.runtimeTested });
      for (const name of [item.name, `${item.name}.sha256`]) copyFileSync(path.join(input, name), path.join(output, name));
    }
    const manifest = { schemaVersion: 1, repository: client.repository, releaseTag: tag,
      releaseCommit: run('git', ['rev-parse', 'HEAD'], root).trim(), source: config.source === 'workflow' ? { ...config, runId: origin.runId } : config, origin,
      inputFingerprint: expectedFingerprint, dotnet: version, status: 'experimental', assets };
    const metadata = path.join(output, dotnetManifestName);
    writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(`${metadata}.sha256`, `${await hashFile(metadata)}  ${dotnetManifestName}\n`);
    console.log(`Prepared CoreCLR from run ${origin.runId}: ${assets.length} packages; mobile runtime execution remains untested.`);
    return manifest;
  });
}

export async function verifyDotnetSet({ root, directory, tag, repository }) {
  assert(stableTag.test(tag), 'Invalid release tag');
  const file = path.join(directory, dotnetManifestName);
  await verifyChecksum(file);
  const manifest = readJson(file);
  const version = dotnetVersion(root);
  validateManifest(manifest, repository, tag, localDotnetFingerprint(root), version);
  assert.equal(manifest.releaseCommit, run('git', ['rev-parse', 'HEAD'], root).trim(), 'CoreCLR release commit mismatch');
  const expected = [dotnetManifestName, `${dotnetManifestName}.sha256`, ...manifest.assets.flatMap(asset => [asset.name, `${asset.name}.sha256`])];
  const actual = readdirSync(directory).filter(name => name.startsWith('star-dotnet-') || name.startsWith('dotnet-'));
  assert.deepEqual(actual.sort(), expected.sort(), 'Unexpected or missing CoreCLR assets');
  await withTemp(async work => {
    for (const item of dotnetPackages(version)) {
      const sha256 = await validateDotnetArchive(root, path.join(directory, item.name), item, version, path.join(work, item.artifact));
      assert.equal(sha256, manifest.assets.find(asset => asset.name === item.name).sha256, 'CoreCLR provenance checksum mismatch');
    }
  });
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, directory] = process.argv.slice(2);
    const root = process.cwd(), tag = process.env.RELEASE_TAG;
    const repository = process.env.GH_REPO || process.env.GITHUB_REPOSITORY;
    if (mode === 'check-config') validateDotnetSource(readSource(root, 'dotnet', tag), tag);
    else if (mode === 'prepare' && directory) await prepareDotnet({ root, output: path.resolve(directory), tag,
      config: readSource(root, 'dotnet', tag), client: new GitHub(repository) });
    else if (mode === 'verify' && directory) await verifyDotnetSet({ root, directory: path.resolve(directory), tag, repository });
    else throw new Error('Usage: node scripts/release/prepare-dotnet.mjs check-config | prepare <directory> | verify <directory>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
