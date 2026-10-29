import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { withTemp } from '../../scripts/release/common.mjs';
import { readReleaseInputs, readSource, selectBuildRun, validateBuildRun } from '../../scripts/release/sources.mjs';

const repository = 'star-e/star-binaries';
const sha = 'a'.repeat(40);
const run = { id: 100, run_number: 100, path: '.github/workflows/sdk.yml', event: 'workflow_dispatch',
  status: 'completed', conclusion: 'success', head_sha: sha, head_repository: { full_name: repository } };

test('one release configuration covers all families without ambiguous sources', async () => withTemp(async root => {
  const inputs = { schemaVersion: 1, sdk: { source: 'workflow', runId: 'latest' },
    v8: { source: 'release', tag: 'v0.1.4' }, dotnet: { source: 'workflow', runId: 123 } };
  const write = value => writeFileSync(path.join(root, 'release-inputs.json'), JSON.stringify(value));
  write(inputs);
  assert.deepEqual(readReleaseInputs(root, 'v0.1.6'), inputs);
  assert.deepEqual(readSource(root, 'sdk', 'v0.1.6'), { schemaVersion: 1, ...inputs.sdk });
  for (const value of [{ ...inputs, dotnet: null }, { ...inputs, extra: {} },
    { ...inputs, sdk: { ...inputs.sdk, tag: 'v0.1.5' } },
    { ...inputs, v8: { source: 'release', tag: 'v0.1.6' } }]) {
    write(value);
    assert.throws(() => readReleaseInputs(root, 'v0.1.6'));
  }
}));

test('latest chooses a complete matching run once; explicit IDs never silently fall back', () => {
  const artifacts = [{ id: 20, name: 'sdk-packages', workflow_run: { head_sha: sha } }];
  let listCalls = 0;
  const client = { repository, api: () => run, tree: head => head,
    pages(route, key) {
      if (key === 'workflow_runs') {
        ++listCalls;
        return [{ ...run, id: 103, run_number: 103, head_sha: 'b'.repeat(40) },
          { ...run, id: 102, run_number: 102 }, { ...run, id: 101, run_number: 101 }, run];
      }
      if (route === 'actions/runs/102/artifacts') return [];
      if (route === 'actions/runs/101/artifacts') return [{ ...artifacts[0], expired: true }];
      return artifacts;
    } };
  const options = { client, config: { runId: 'latest' }, workflow: 'sdk.yml', fingerprint: value => value,
    expectedFingerprint: sha, artifacts: ['sdk-packages'] };
  const selected = selectBuildRun(options);
  assert.deepEqual(selected.origin, { runId: 100, headSha: sha });
  assert.equal(listCalls, 1);
  artifacts[0].expired = true;
  assert.throws(() => selectBuildRun({ ...options, config: { runId: 100 } }), /Expired/);
  assert.equal(listCalls, 1);
  assert.throws(() => selectBuildRun(options), /No complete matching/);
});

test('source run requires the selected workflow, repository, success and manual trigger', () => {
  for (const edit of [{ status: 'in_progress' }, { conclusion: 'failure' }, { event: 'pull_request' },
    { event: 'push' }, { head_sha: '' }, { path: '.github/workflows/v8.yml' },
    { head_repository: { full_name: 'fork/star-binaries' } }]) {
    assert.throws(() => validateBuildRun({ ...run, ...edit }, repository, 'sdk.yml'));
  }
  assert.deepEqual(validateBuildRun(run, repository, 'sdk.yml'), { runId: 100, headSha: sha });
});
