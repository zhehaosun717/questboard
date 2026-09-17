// Round-2 wiring: the running board must create its default usage service from the project config, and the
// settings save must refuse an invalid Alibaba choice instead of silently writing "unknown" into the config.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startFixture } from './fixture.js';
import { CONFIG_FILE } from '../../src/core/config.js';
import { NVIDIA_MANUAL_NOTE } from '../../src/usage/manualProviders.js';

describe('usage service wiring through the real server', () => {
  it('serves a manual provider enabled in the project config through the default usage service', async () => {
    // No `usage` is injected: this exercises createServer's own default, which must read the config's
    // usage.manualProviders. The manual provider's read is a local stub, so no network is involved, and a
    // provider= request never starts any other provider's read.
    const fixture = await startFixture({ projectOverrides: { usage: { manualProviders: ['nvidia'] } } });
    try {
      const res = await fixture.api('/api/usage?provider=nvidia');
      assert.equal(res.status, 200, res.text);
      const entry = res.body.providers.find((e) => e.id === 'nvidia');
      assert.equal(entry.providerState, 'manual_only');
      assert.equal(entry.ok, false);
      assert.equal(entry.state, 'unconfigured', 'a manual card has no automatic reading to call fresh');
      assert.equal(entry.error, NVIDIA_MANUAL_NOTE);
      assert.ok(!res.body.providers.some((e) => e.id !== 'nvidia' && e.state !== 'pending'), 'no other provider was read');
    } finally {
      await fixture.close();
    }
  });

  it('refuses an invalid Alibaba choice at the settings save with a Chinese message naming the field', async () => {
    const fixture = await startFixture();
    try {
      const file = path.join(fixture.project.root, CONFIG_FILE);
      const before = fs.readFileSync(file, 'utf8');
      const raw = {
        name: 'Usage settings',
        lanes: { files: { run: ['node', 'worker.js'], outputDir: 'out' } },
        usage: { manualProviders: ['alibaba-token-plan'], alibaba: { edition: 'hacked-edition', region: 'cn-beijing' } },
      };
      const res = await fixture.api('/api/settings', 'POST', { raw });
      assert.equal(res.status, 400);
      assert.match(res.body.error, /usage\.alibaba\.edition/);
      assert.match(res.body.error, /阿里云版本/);
      assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refused save changes nothing on disk');
    } finally {
      await fixture.close();
    }
  });
});
