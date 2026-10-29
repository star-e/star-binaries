import assert from 'node:assert/strict';
import path from 'node:path';
import { readJson, shaPattern, validateSource } from './common.mjs';

export const families = ['sdk', 'v8', 'dotnet'];

export function readReleaseInputs(root, tag) {
  const inputs = readJson(path.join(root, 'release-inputs.json'));
  assert.equal(inputs.schemaVersion, 1, 'Unsupported release inputs schema');
  assert.deepEqual(Object.keys(inputs).sort(), [...families, 'schemaVersion'].sort(), 'Specify all three package sources');
  for (const family of families) {
    assert(inputs[family] && typeof inputs[family] === 'object' && !Array.isArray(inputs[family]),
      `Specify a source object for ${family}`);
    assert(!Object.hasOwn(inputs[family], 'schemaVersion'), 'Source schemaVersion belongs at the top level');
    validateSource({ schemaVersion: 1, ...inputs[family] }, tag);
  }
  return inputs;
}

export function readSource(root, family, tag) {
  assert(families.includes(family), 'Unknown package family');
  return { schemaVersion: 1, ...readReleaseInputs(root, tag)[family] };
}

export function oneAsset(assets, name) {
  const matches = assets.filter(asset => asset.name === name);
  assert.equal(matches.length, 1, `Missing or ambiguous asset: ${name}`);
  return matches[0];
}

export function requireArtifacts(assets, names, origin) {
  for (const name of names) {
    const artifact = oneAsset(assets, name);
    assert(!artifact.expired, `Expired artifact: ${name}; select a published release or rebuild`);
    assert.equal(artifact.workflow_run?.head_sha, origin.headSha, 'Artifact source mismatch');
    assert(Number.isSafeInteger(artifact.id) && artifact.id > 0, 'Invalid artifact ID');
  }
}

export function validateBuildRun(info, repository, workflow, events = ['workflow_dispatch']) {
  assert(Number.isSafeInteger(info.id) && info.id > 0, 'Invalid build run ID');
  assert.equal(info.path, `.github/workflows/${workflow}`, 'Wrong build workflow');
  assert(events.includes(info.event), 'Unsupported build event');
  assert.equal(info.status, 'completed', 'Build has not completed');
  assert.equal(info.conclusion, 'success', 'All build and validation jobs must succeed');
  assert.equal(info.head_repository?.full_name?.toLowerCase(), repository.toLowerCase(), 'Fork artifacts are not release inputs');
  assert(shaPattern.test(info.head_sha), 'Missing build source commit');
  return { runId: info.id, headSha: info.head_sha };
}

// Resolve once per package family, then use the returned origin/assets for every
// download. Never combine platforms from independent workflow runs.
export function selectBuildRun({ client, config, workflow, fingerprint, expectedFingerprint, artifacts,
  validate = info => validateBuildRun(info, client.repository, workflow) }) {
  const automatic = config.runId === 'latest';
  const candidates = automatic
    ? client.pages(`actions/workflows/${workflow}/runs?status=success&branch=main`, 'workflow_runs')
      .sort((a, b) => b.run_number - a.run_number || b.id - a.id)
    : [client.api(`actions/runs/${config.runId}`)];
  for (const info of candidates) {
    try {
      const origin = validate(info);
      if (!automatic) assert.equal(origin.runId, config.runId, 'Wrong workflow run');
      assert.equal(fingerprint(client.tree(origin.headSha)), expectedFingerprint,
        'Build inputs differ from the release commit');
      const assets = client.pages(`actions/runs/${origin.runId}/artifacts`, 'artifacts');
      requireArtifacts(assets, artifacts, origin);
      return { origin, assets };
    } catch (error) {
      if (!automatic) throw error;
      console.log(`Skipping ${workflow} run ${info.id}: ${error.message}`);
    }
  }
  throw new Error(`No complete matching ${workflow} run on main. Select a run/release in release-inputs.json.`);
}
