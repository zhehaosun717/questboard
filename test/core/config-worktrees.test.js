// FB2-13 (条目 29): policy.worktrees { enabled, dir, base } — off by default, every field validated at
// load; a half-written block must fail startup, never silently fall back on.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

describe('policy.worktrees config validation (FB2-13)', () => {
  it('absent means off, with no object invented', () => {
    const { config } = makeProject();
    assert.equal(config.policy.worktrees, null);
  });

  it('enabled fills dir and base defaults', () => {
    const { config } = makeProject({ policy: { worktrees: { enabled: true } } });
    assert.deepEqual(config.policy.worktrees, { enabled: true, dir: '.qb-worktrees', base: 'HEAD' });
  });

  it('custom dir and base are kept', () => {
    const { config } = makeProject({ policy: { worktrees: { enabled: true, dir: '.wt', base: 'main' } } });
    assert.deepEqual(config.policy.worktrees, { enabled: true, dir: '.wt', base: 'main' });
  });

  it('enabled: false is a legal explicit off', () => {
    const { config } = makeProject({ policy: { worktrees: { enabled: false } } });
    assert.equal(config.policy.worktrees, null);
  });

  it('bad shapes fail loudly, in Chinese, naming the field', () => {
    assert.throws(() => makeProject({ policy: { worktrees: { enabled: 'yes' } } }), /policy.worktrees.enabled/);
    assert.throws(() => makeProject({ policy: { worktrees: { enabled: true, dir: '../escape' } } }), /policy.worktrees.dir/);
    assert.throws(() => makeProject({ policy: { worktrees: { enabled: true, dir: '/abs' } } }), /policy.worktrees.dir/);
    assert.throws(() => makeProject({ policy: { worktrees: { enabled: true, dir: '' } } }), /policy.worktrees.dir/);
    assert.throws(() => makeProject({ policy: { worktrees: { enabled: true, extra: 1 } } }), /不是认识的字段/);
    assert.throws(() => makeProject({ policy: { worktrees: { enabled: true, base: 1 } } }), /policy.worktrees.base/);
  });
});
