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
  ['missing', 1, false, false], ['stale', 1, false, true], ['failed', 1, false, true]
]) {
  test(`simulator controller: ${scenario}`, async () => withTemp(async work => {
    const result = spawnSync('cmake', [`-DTEST_ROOT=${work}`, `-DSCENARIO=${scenario}`, '-P', fixture],
      { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status === 0, passes, result.stdout + result.stderr);
    const calls = readFileSync(path.join(work, 'calls.txt'), 'utf8');
    assert.equal((calls.match(/get_app_container/g) || []).length, queries);
    assert.equal(calls.includes(';launch;'), launches);
    const log = readFileSync(path.join(work, 'simulator.log'), 'utf8').replace(/\r\n/g, '\n');
    if (passes) assert.match(log, /Completed: TRUE\nResult: [0-9a-f]{32} STAR_IOS_SMOKE_PASSED/);
    if (scenario === 'timeout') assert.match(result.stdout + result.stderr, /Process terminated due to timeout/);
    if (scenario === 'error') assert.match(result.stdout + result.stderr, /current state: Shutdown/);
    if (scenario === 'stale') assert.match(log, /Completed: FALSE/);
    if (scenario === 'failed') assert.match(log, /Completed: TRUE\nResult: [0-9a-f]{32} STAR_IOS_SMOKE_FAILED/);
  }));
}
