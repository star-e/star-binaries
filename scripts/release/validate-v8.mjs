import assert from 'node:assert/strict';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { localFingerprint, manifestName, readJson, run, triplets, v8Version,
  validateV8Archive, verifyChecksum, withTemp } from './common.mjs';
import { validateManifest, validationMode } from './prepare-v8.mjs';

// Only write a receipt after the current consumer has passed against these bytes.
export async function validateSDK({ root, directory, triplet, receipts, repository, runId, execute = spawnSync }) {
  assert(triplets.includes(triplet), 'Unsupported V8 triplet');
  const receiptPath = path.join(receipts, `${triplet}.json`);
  if (existsSync(receiptPath)) unlinkSync(receiptPath);
  assert(Number.isSafeInteger(runId) && runId > 0, 'Pass the validation Actions run ID');
  const metadata = path.join(directory, manifestName);
  await verifyChecksum(metadata);
  const manifest = readJson(metadata);
  const version = v8Version(root);
  validateManifest(manifest, repository, manifest.releaseTag, localFingerprint(root), version);
  assert.equal(manifest.releaseCommit, run('git', ['rev-parse', 'HEAD'], root).trim(), 'Validation commit mismatch');
  assert.equal(manifest.validationFingerprint, localFingerprint(root, 'validation'), 'Validation scripts changed');
  const asset = manifest.assets.find(item => item.triplet === triplet);
  const archive = path.resolve(directory, asset.name);
  await withTemp(async work => {
    assert.equal(await validateV8Archive(archive, triplet, version, manifest.origin.headSha, work),
      asset.sha256, 'Validation archive checksum mismatch');
  });
  const result = execute('cmake', [`-DTRIPLET=${triplet}`, `-DARCHIVE=${archive}`,
    `-DSOURCE_SHA=${manifest.origin.headSha}`, `-DEXPECTED_SHA256=${asset.sha256}`,
    `-DSIMULATOR_UDID=${process.env.SIMULATOR_UDID || ''}`,
    `-DANDROID_SERIAL=${process.env.ANDROID_SERIAL || ''}`, '-P', 'scripts/v8/validate-sdk.cmake'],
  { cwd: root, stdio: 'inherit' });
  assert.ifError(result.error);
  assert.equal(result.status, 0, 'V8 SDK consumer validation failed');
  assert.equal(await verifyChecksum(archive), asset.sha256, 'SDK changed during validation');
  const receipt = { schemaVersion: 1, repository, runId, validationCommit: manifest.releaseCommit,
    validationFingerprint: manifest.validationFingerprint, buildFingerprint: manifest.buildFingerprint,
    origin: manifest.origin, triplet, name: asset.name, sha256: asset.sha256,
    configurations: ['Release', 'Debug'], mode: validationMode(triplet), result: 'passed' };
  mkdirSync(receipts, { recursive: true });
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [directory, triplet, receipts] = process.argv.slice(2);
    assert(directory && receipts, 'Usage: validate-v8.mjs <inputs> <triplet> <receipts>');
    await validateSDK({ root: process.cwd(), directory, triplet, receipts,
      repository: process.env.GITHUB_REPOSITORY, runId: Number(process.env.GITHUB_RUN_ID) });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
