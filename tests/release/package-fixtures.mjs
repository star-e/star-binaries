// Tiny format fixtures only; these do not execute native or managed runtimes.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { archiveName, hashFile, linkage, localFingerprint, manifestName, readJson, run, triplets,
  v8Version } from '../../scripts/release/common.mjs';
import { validationMode } from '../../scripts/release/prepare-v8.mjs';
import { dotnetManifestName, dotnetPackages, dotnetVersion, localDotnetFingerprint } from '../../scripts/release/prepare-dotnet.mjs';

function write(file, content) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, content); }
async function sidecar(file) { write(`${file}.sha256`, `${await hashFile(file)}  ${path.basename(file)}\n`); }
async function archive(stage, output, base, name, files) {
  for (const [file, content] of Object.entries(files)) write(path.join(stage, base, file), content);
  const destination = path.join(output, name);
  run('cmake', ['-E', 'tar', name.endsWith('.zip') ? 'cf' : 'czf', destination,
    name.endsWith('.zip') ? '--format=zip' : '--format=gnutar', base], stage);
  await sidecar(destination);
  return hashFile(destination);
}
async function metadata(output, name, value) {
  write(path.join(output, name), JSON.stringify(value)); await sidecar(path.join(output, name));
}

export async function otherFamilies(root, work, output, repository, tag) {
  const headSha = run('git', ['rev-parse', 'HEAD'], root).trim();
  const v8 = v8Version(root), origin = { runId: 123, headSha };
  const manifest = { schemaVersion: 2, repository, releaseTag: tag, releaseCommit: headSha,
    source: { schemaVersion: 1, source: 'workflow', runId: 123 }, origin,
    buildFingerprint: localFingerprint(root), validationFingerprint: localFingerprint(root, 'validation'),
    v8Version: v8.version, assets: [], validations: [] };
  for (const triplet of triplets) {
    const name = archiveName(v8.version, triplet), base = path.basename(name, '.zip');
    const files = { 'provenance/identity.txt': Object.entries({ source: headSha, v8: v8.revision,
      depot_tools: v8.depot, triplet, linkage: linkage(triplet), pointer_compression: 'true', sandbox: 'true' })
      .map(([key, value]) => `${key}=${value}`).join('\n'), 'share/v8/V8Config.cmake': '', 'share/v8/V8ConfigVersion.cmake': '' };
    for (const config of ['Release', 'Debug']) {
      const lower = config.toLowerCase(), prefix = config === 'Debug' ? 'debug/' : '';
      files[`provenance/build-${lower}.txt`] = `configuration=${config}\n`;
      files[`provenance/${lower}-args.gn`] = '';
      files[`${lower}/include/v8-gn.h`] = '';
      if (linkage(triplet) === 'static') files[`${prefix}lib/libv8_monolith.a`] = 'fixture';
      else {
        for (const part of ['v8', 'v8_libplatform', 'v8_libbase']) {
          if (triplet.includes('windows')) {
            files[`${prefix}bin/${part}.dll`] = 'fixture'; files[`${prefix}lib/${part}.dll.lib`] = 'fixture';
          } else files[`${prefix}lib/lib${part}.${triplet.includes('osx') ? 'dylib' : 'cr.so'}`] = 'fixture';
        }
        if (triplet.includes('android')) files[`${prefix}lib/libc++_shared.so`] = 'fixture';
      }
    }
    const asset = { triplet, name, sha256: await archive(path.join(work, 'v8', triplet), output, base, name, files) };
    manifest.assets.push(asset);
    manifest.validations.push({ schemaVersion: 1, repository, runId: 456, validationCommit: headSha,
      validationFingerprint: manifest.validationFingerprint, buildFingerprint: manifest.buildFingerprint,
      origin, ...asset, configurations: ['Release', 'Debug'], mode: validationMode(triplet), result: 'passed' });
  }
  await metadata(output, manifestName, manifest);
  const version = dotnetVersion(root), assets = [];
  for (const item of dotnetPackages(version)) {
    const build = { schemaVersion: 1, upstreamVersion: version.version, sourceRevision: version.revision,
      sourceTag: version.sourceTag, runtimeVersion: version.runtimeVersion, triplet: item.triplet, configuration: 'Release' };
    const files = { 'LICENSE.TXT': 'fixture', 'THIRD-PARTY-NOTICES.TXT': 'fixture' };
    if (item.profile === 'mobile') {
      const rid = { 'arm64-android-star': 'android-arm64', 'x64-android-star': 'android-x64',
        'arm64-ios-star': 'ios-arm64', 'arm64-ios-simulator-star': 'iossimulator-arm64' }[item.triplet];
      Object.assign(build, { rid, runtimeFlavor: 'CoreCLR', artifactKind: 'runtime-pack', runtimeTested: false,
        validation: 'package-content-and-native-target', executionMode: rid.startsWith('android-') ? 'JIT+ReadyToRun' : 'Interpreter+ReadyToRun' });
      files[`packs/Microsoft.NETCore.App.Runtime.${rid}.${version.runtimeVersion}.nupkg`] = 'fixture';
      files['include/coreclrhost.h'] = 'fixture';
    } else {
      build.consumerSdk = version.consumerSdk;
      files[`runtime/shared/Microsoft.NETCore.App/${version.runtimeVersion}/System.Private.CoreLib.dll`] = 'fixture';
      files['include/hostfxr.h'] = 'fixture'; files['share/dotnet/StarDotNetConfig.cmake'] = 'fixture';
      if (item.profile === 'base') {
        build.profile = 'base';
        files['provenance/profile.json'] = JSON.stringify(readJson(path.join(root, 'scripts/dotnet/profiles/base.json')));
        const profile = path.join(work, item.artifact, 'profile.json');
        write(profile, files['provenance/profile.json']); build.profileSha256 = await hashFile(profile);
      }
    }
    files['provenance/build.json'] = JSON.stringify(build);
    const stage = path.join(work, item.artifact);
    for (const [file, value] of Object.entries(files)) write(path.join(stage, item.base, file), value);
    files['provenance/files.sha256'] = (await Promise.all(Object.keys(files).map(async file =>
      `${await hashFile(path.join(stage, item.base, file))}  ${file}\n`))).join('');
    assets.push({ triplet: item.triplet, profile: item.profile, name: item.name, runtimeTested: item.runtimeTested,
      sha256: await archive(stage, output, item.base, item.name, files) });
  }
  await metadata(output, dotnetManifestName, { schemaVersion: 1, repository, releaseTag: tag,
    releaseCommit: headSha, source: { schemaVersion: 1, source: 'workflow', runId: 789 },
    origin: { runId: 789, headSha }, inputFingerprint: localDotnetFingerprint(root), dotnet: version, status: 'experimental', assets });
}
