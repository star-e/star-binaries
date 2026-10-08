import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, closeSync, openSync, mkdirSync, readFileSync, readdirSync, statSync,
  mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';

export const triplets = ['x64-windows-star', 'arm64-osx-star', 'arm64-android-star',
  'x64-android-star', 'arm64-ios-star', 'arm64-ios-simulator-star'];
export const stableTag = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const shaPattern = /^[0-9a-f]{40}$/;
export const hashPattern = /^[0-9a-f]{64}$/;
export const manifestName = 'v8-provenance.json';
export const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
export const run = (command, args, cwd) => execFileSync(command, args,
  { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

export async function withTemp(callback) {
  const parent = realpathSync(os.tmpdir());
  const directory = mkdtempSync(path.join(parent, 'star-release-'));
  try { return await callback(directory); }
  finally {
    assert.equal(path.dirname(realpathSync(directory)), parent);
    assert(path.basename(directory).startsWith('star-release-'));
    rmSync(directory, { recursive: true });
  }
}

export async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function validateSource(config, releaseTag) {
  assert.equal(config.schemaVersion, 1, 'Unsupported V8 release config schema');
  assert(stableTag.test(releaseTag), 'Expected a stable destination release tag');
  if (config.source === 'workflow') {
    assert(Number.isSafeInteger(config.runId) && config.runId > 0, 'Specify a positive Build V8 runId');
    assert.deepEqual(Object.keys(config).sort(), ['runId', 'schemaVersion', 'source']);
  } else if (config.source === 'release') {
    assert(stableTag.test(config.tag) && config.tag !== releaseTag, 'Specify a different source release tag');
    assert.deepEqual(Object.keys(config).sort(), ['schemaVersion', 'source', 'tag']);
  } else {
    throw new Error('Configure v8-release.json: source must be workflow (runId) or release (tag). V8 is never rebuilt during publication.');
  }
  return config;
}

// Git blob identities are independent of CRLF checkout conversion. Exclude the
// release tooling/config itself so changing a release source does not rebuild V8.
function isLegacyV8Input(name) {
  return ['.gitattributes', 'v8-version.cmake', 'scripts/build-v8.cmake',
    'scripts/ios-simulator-smoke.cmake', 'scripts/shutdown-ios-simulator.ps1',
    '.github/workflows/v8.yml', 'tests/ios/main.mm', 'tests/ios/Info.plist.in'].includes(name) ||
    ['scripts/v8/', 'patches/v8/', 'tests/v8/'].some(prefix => name.startsWith(prefix));
}

function isV8Input(name, kind) {
  const validation = ['scripts/ios-simulator-smoke.cmake', 'scripts/shutdown-ios-simulator.ps1',
    '.github/workflows/validate-v8.yml', 'tests/ios/main.mm', 'tests/ios/Info.plist.in'].includes(name) ||
    name.startsWith('tests/v8/') || name.startsWith('scripts/v8/validate') ||
    name.startsWith('scripts/release/');
  if (kind === 'legacy') return isLegacyV8Input(name);
  if (kind === 'validation') return validation;
  assert.equal(kind, 'build');
  return isLegacyV8Input(name) && !validation;
}

export function fingerprint(tree, kind = 'build') {
  const files = tree.filter(entry => isV8Input(entry.path, kind) && entry.type !== 'tree')
    .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const requiredFiles = kind === 'validation' ? ['scripts/v8/validate.cmake', 'tests/v8/CMakeLists.txt'] :
    ['v8-version.cmake', 'scripts/build-v8.cmake', 'scripts/v8/args.cmake', '.github/workflows/v8.yml'];
  for (const required of requiredFiles) {
    assert(files.some(file => file.path === required), `Missing V8 input: ${required}`);
  }
  for (const file of files) {
    assert(file.type === 'blob' && /^100(644|755)$/.test(file.mode) && shaPattern.test(file.sha),
      `Unsupported V8 input: ${file.path}`);
  }
  return createHash('sha256').update(files.map(file =>
    `${file.mode} ${file.sha} ${file.path}\n`).join('')).digest('hex');
}

export function localFingerprint(root, kind = 'build') {
  const modified = run('git', ['diff', '--name-only', '-z', 'HEAD'], root).split('\0');
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard', '-z'], root).split('\0');
  assert(![...modified, ...untracked].some(name => isV8Input(name, kind)), 'Commit V8 input changes before preparing release assets');
  const entries = run('git', ['ls-tree', '-rz', '--full-tree', 'HEAD'], root).split('\0').filter(Boolean);
  return fingerprint(entries.map(entry => {
    const [, mode, type, sha, name] = /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
    return { mode, type, sha, path: name };
  }), kind);
}

export function v8Version(root) {
  const text = readFileSync(path.join(root, 'v8-version.cmake'), 'utf8');
  const get = name => {
    const match = text.match(new RegExp(`set\\(${name} "([^"]+)"\\)`));
    assert(match, `Missing ${name}`);
    return match[1];
  };
  const version = get('STAR_V8_VERSION');
  assert(/^\d+\.\d+\.\d+\.\d+$/.test(version), 'Invalid V8 version');
  return { version, revision: get('STAR_V8_REVISION'), depot: get('STAR_DEPOT_TOOLS_REVISION') };
}

export const linkage = triplet => triplet.includes('-ios') ? 'static' : 'shared';
export const archiveName = (version, triplet) => `star-v8-${version}-${triplet}-${linkage(triplet)}-sdk.zip`;

export async function verifyChecksum(file) {
  assert(statSync(file).isFile() && statSync(file).size > 0, `Missing or empty asset: ${file}`);
  const expected = readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/);
  assert.equal(expected.length, 2, `Invalid checksum sidecar: ${file}`);
  const actual = await hashFile(file);
  assert.equal(expected[0], actual, `Checksum mismatch: ${file}`);
  assert.equal(expected[1], path.basename(file), `Checksum filename mismatch: ${file}`);
  return actual;
}

export function extractSelected(archive, directory, required, base) {
  const entries = run('cmake', ['-E', 'tar', 'tf', archive]).trim().split(/\r?\n/);
  for (const name of entries) {
    assert(!name.includes('\\') && !name.split('/').includes('..') &&
      (base ? name === `${base}/` || name.startsWith(`${base}/`) : required.includes(name)),
    `Unexpected archive entry: ${name}`);
  }
  assert.equal(new Set(entries).size, entries.length, 'Duplicate archive entries');
  for (const name of required) assert(entries.includes(name), `Incomplete SDK: ${name}`);
  mkdirSync(directory, { recursive: true });
  run('cmake', ['-E', 'tar', 'xf', archive, ...required], directory);
  return entries;
}

export async function validateV8Archive(file, triplet, version, sourceSha, work) {
  assert.equal(path.basename(file), archiveName(version.version, triplet));
  const checksum = await verifyChecksum(file);
  const base = path.basename(file, '.zip');
  const metadata = ['provenance/identity.txt', 'share/v8/V8Config.cmake', 'share/v8/V8ConfigVersion.cmake'];
  for (const config of ['release', 'debug']) {
    metadata.push(`provenance/build-${config}.txt`, `provenance/${config}-args.gn`, `${config}/include/v8-gn.h`);
  }
  const entries = extractSelected(file, work, metadata.map(name => `${base}/${name}`), base);
  // Release libraries use lib/bin, whereas Debug libraries use debug/lib/bin.
  for (const prefix of ['', 'debug/']) {
    const required = linkage(triplet) === 'static' ? ['lib/libv8_monolith.a'] :
      ['v8', 'v8_libplatform', 'v8_libbase'].flatMap(component => {
        if (triplet.includes('windows')) return [`bin/${component}.dll`, `lib/${component}.dll.lib`];
        return [`lib/lib${component}.${triplet.includes('osx') ? 'dylib' : 'cr.so'}`];
      });
    if (triplet.includes('android')) required.push('lib/libc++_shared.so');
    for (const name of required) assert(entries.includes(`${base}/${prefix}${name}`), `Missing V8 library: ${prefix}${name}`);
  }
  const identity = readFileSync(path.join(work, base, metadata[0]), 'utf8');
  for (const [name, value] of Object.entries({ source: sourceSha, v8: version.revision,
    depot_tools: version.depot, triplet, linkage: linkage(triplet), pointer_compression: 'true', sandbox: 'true' })) {
    assert.equal(identity.split(/\r?\n/).filter(line => line.startsWith(`${name}=`)).join(), `${name}=${value}`,
      `SDK identity mismatch: ${name}`);
  }
  for (const config of ['Release', 'Debug']) {
    const text = readFileSync(path.join(work, base, `provenance/build-${config.toLowerCase()}.txt`), 'utf8');
    assert(text.split(/\r?\n/).includes(`configuration=${config}`), `Missing ${config} provenance`);
  }
  return checksum;
}

export function assertNames(directory, names) {
  assert.deepEqual(readdirSync(directory).sort(), [...names].sort(), `Unexpected or missing assets in ${directory}`);
}

export class GitHub {
  constructor(repository) {
    assert(/^[\w-]+\/[\w.-]+$/.test(repository), 'Invalid repository');
    this.repository = repository;
  }
  api(route) { return JSON.parse(run('gh', ['api', `repos/${this.repository}/${route}`])); }
  pages(route, key) {
    const items = [];
    for (let page = 1; ; page++) {
      const value = this.api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const next = key ? value[key] : value;
      assert(Array.isArray(next), 'Invalid GitHub page');
      items.push(...next);
      if (next.length < 100) return items;
    }
  }
  tree(sha) {
    assert(shaPattern.test(sha), 'Invalid source commit');
    const result = this.api(`git/trees/${sha}?recursive=1`);
    assert(!result.truncated, 'Source tree is truncated');
    return result.tree;
  }
  download(route, file, accept = 'application/vnd.github+json') {
    mkdirSync(path.dirname(file), { recursive: true });
    const fd = openSync(file, 'wx');
    try {
      // Actions artifacts use the JSON API to redirect to a ZIP download.
      // Only Release assets require octet-stream to select the binary response.
      const result = spawnSync('gh', ['api', '-H', `Accept: ${accept}`,
        `repos/${this.repository}/${route}`], { stdio: ['ignore', fd, 'inherit'] });
      assert.equal(result.status, 0, `Download failed: ${route}`);
    } finally { closeSync(fd); }
  }
  downloadReleaseAsset(asset, file) {
    assert(Number.isSafeInteger(asset.id) && asset.id > 0 && asset.state === 'uploaded', 'Invalid release asset');
    this.download(`releases/assets/${asset.id}`, file, 'application/octet-stream');
  }
  upload(tag, file) {
    run('gh', ['release', 'upload', tag, file, '--repo', this.repository]);
  }
}
