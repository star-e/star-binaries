import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { withTemp } from '../../scripts/release/common.mjs';

const fixture = fileURLToPath(new URL('./simulator-smoke-fixture.cmake', import.meta.url));
for (const [scenario, queries, passes, launches] of [
  ['success', 1, true, true], ['retry', 2, true, true],
  ['timeout', 2, false, false], ['error', 1, false, false],
  ['missing', 1, false, false], ['stale', 1, false, true], ['failed', 1, false, true],
  ['launch-timeout-late', 1, true, true], ['launch-timeout-empty', 1, false, true],
  ['launch-timeout-stale', 1, false, true], ['launch-timeout-failed', 1, false, true],
  ['launch-error', 1, false, true]
]) {
  test(`simulator controller: ${scenario}`, async () => withTemp(async work => {
    const result = spawnSync('cmake', [`-DTEST_ROOT=${work}`, `-DSCENARIO=${scenario}`, '-P', fixture],
      { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status === 0, passes, result.stdout + result.stderr);
    const calls = readFileSync(path.join(work, 'calls.txt'), 'utf8');
    assert.equal((calls.match(/get_app_container/g) || []).length, queries);
    assert.equal(calls.includes(';launch;'), launches);
    assert.equal((calls.match(/;launch;/g) || []).length, launches ? 1 : 0);
    const log = readFileSync(path.join(work, 'simulator.log'), 'utf8').replace(/\r\n/g, '\n');
    if (passes) assert.match(log, /Completed: TRUE\nResult: [0-9a-f]{32} STAR_IOS_SMOKE_PASSED/);
    if (scenario === 'timeout') assert.match(result.stdout + result.stderr, /Process terminated due to timeout/);
    if (scenario === 'error') assert.match(result.stdout + result.stderr, /current state: Shutdown/);
    if (scenario.endsWith('stale') || scenario === 'launch-timeout-empty') assert.match(log, /Completed: FALSE/);
    if (scenario.endsWith('failed')) assert.match(log, /Completed: TRUE\nResult: [0-9a-f]{32} STAR_IOS_SMOKE_FAILED/);
    if (scenario === 'launch-timeout-late') {
      assert.match(result.stdout, /timed out, but this launch's smoke test acknowledged success/);
      assert.ok(calls.indexOf(';sleep;1') >= 0);
      assert.ok(calls.indexOf(';sleep;1') < calls.indexOf(';terminate;'));
    }
    if (scenario === 'launch-timeout-empty' || scenario.endsWith('stale')) {
      assert.equal((calls.match(/;sleep;1\r?\n/g) || []).length, 120);
    }
    if (scenario === 'launch-error') assert.ok(!calls.includes(';sleep;'));
  }));
}
