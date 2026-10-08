import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitHub, hashFile, manifestName, stableTag, verifyChecksum, withTemp } from './common.mjs';
import { verifyV8Set } from './prepare-v8.mjs';

export async function uploadAssets({ client, directory, tag }) {
  assert(stableTag.test(tag), 'Invalid release tag');
  const files = readdirSync(directory).sort();
  assert(files.every(name => /^[A-Za-z0-9_.-]+$/.test(name)), 'Invalid release asset filename');
  const payloads = files.filter(name => name.endsWith('.zip') || name === manifestName);
  assert(payloads.length > 0, 'No release assets');
  assert.deepEqual(files, payloads.flatMap(name => [name, `${name}.sha256`]).sort(), 'Unexpected or missing release files');
  for (const name of payloads) await verifyChecksum(path.join(directory, name));
  const release = client.api(`releases/tags/${tag}`);
  assert.equal(release.tag_name, tag);
  assert(!release.draft && !release.prerelease, 'Destination must be a published stable release');
  const remote = client.pages(`releases/${release.id}/assets`);
  const pending = [];
  await withTemp(async work => {
    // Check every conflict BEFORE uploading anything. Never use --clobber.
    for (const name of files) {
      const matches = remote.filter(asset => asset.name === name);
      assert(matches.length <= 1, `Duplicate remote asset: ${name}`);
      if (!matches.length) { pending.push(name); continue; }
      const existing = matches[0];
      const expected = await hashFile(path.join(directory, name));
      assert.equal(existing.state, 'uploaded', `Incomplete remote asset: ${name}`);
      if (existing.digest) assert.equal(existing.digest, `sha256:${expected}`, `Published asset differs: ${name}`);
      else {
        const downloaded = path.join(work, name);
        client.downloadReleaseAsset(existing, downloaded);
        assert.equal(await hashFile(downloaded), expected, `Published asset differs: ${name}`);
      }
    }
  });
  for (const name of pending) client.upload(tag, path.join(directory, name));
  console.log(`Uploaded ${pending.length} assets; ${files.length - pending.length} identical assets already present.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert(process.argv[2], 'Pass a release asset directory');
    const directory = path.resolve(process.argv[2]);
    const tag = process.env.RELEASE_TAG;
    const client = new GitHub(process.env.GH_REPO || process.env.GITHUB_REPOSITORY);
    await verifyV8Set({ root: process.cwd(), directory, tag, repository: client.repository });
    await uploadAssets({ client, directory, tag });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
