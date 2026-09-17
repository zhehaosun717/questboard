// Job Object helper: create, assign a disposable child, terminate the job, and verify the job is empty.
// The child is this test's own spawn and is killed in finally, so no process can outlive the test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  assignJobObject, closeJobObject, countJobObject, createJobObject, stopJobDaemon, terminateJobObject,
} from '../../src/core/jobObject.js';

describe('job object helper', () => {
  it('terminates every process assigned to the job and reports an empty job afterwards', async () => {
    if (process.platform !== 'win32') return;
    const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: 'ignore' });
    try {
      const jobId = await createJobObject('qb-test-' + Date.now());
      try {
        await assignJobObject(jobId, child.pid);
        assert.equal(await countJobObject(jobId), 1, 'the assigned child is counted inside the job');
        await terminateJobObject(jobId);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert.equal(await countJobObject(jobId), 0, 'the job is verified empty after termination');
      } finally {
        await closeJobObject(jobId);
      }
    } finally {
      try { child.kill(); } catch {}
      stopJobDaemon();
    }
  });
});