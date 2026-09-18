// Feedback (owner report 2026-09-17): a project whose configured port is already taken was a dead end — the
// settings page that changes the port sits behind the page that never opens, so the desktop app could only
// say "close the program, or change the port in the config". `questboard port <n>` is the single supported
// writer for that one field, and the desktop shell calls exactly this argument order.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commands } from '../../src/cli/commands.js';
import { CONFIG_FILE } from '../../src/core/config.js';
import { makeProject } from '../helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
const readConfig = (root) => JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
const backups = (root) => fs.readdirSync(root).filter((name) => name.startsWith(`${CONFIG_FILE}.bak-`));

describe('questboard port', () => {
  it('changes only the port, keeps every other field, and keeps the previous file as a timestamped backup', async () => {
    const project = makeProject();
    const file = path.join(project.root, CONFIG_FILE);
    const before = fs.readFileSync(file, 'utf8');

    await commands.port(['6098', '--project', project.root]);

    assert.equal(readConfig(project.root).port, 6098);
    assert.deepEqual({ ...readConfig(project.root), port: 0 }, { ...JSON.parse(before), port: 0 }, 'only port may change');
    const kept = backups(project.root);
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(project.root, kept[0]), 'utf8'), before);
  });

  it('refuses a bad port without touching the file, and says why', async () => {
    const project = makeProject();
    const file = path.join(project.root, CONFIG_FILE);
    const before = fs.readFileSync(file, 'utf8');
    for (const bad of ['6666', '0', 'abc', '6097.5', '70000']) {
      await assert.rejects(commands.port([bad, '--project', project.root]), /--port/, `port ${bad} should be refused`);
    }
    await assert.rejects(commands.port(['--project', project.root]), /usage: questboard port/, 'a missing port is refused with the usage line');
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(backups(project.root).length, 0, 'nothing was written, so nothing was backed up either');
  });

  // The point of reading the raw file: a config whose port is *already* refused (a blocked port, a string, an
  // out-of-range number) must still be repairable from here — going through loadProjectConfig would throw on
  // the very file this command exists to fix.
  it('repairs a config whose stored port is already unacceptable', async () => {
    const project = makeProject();
    const file = path.join(project.root, CONFIG_FILE);
    const base = readConfig(project.root);
    for (const broken of [6666, '6098', 70000, null]) {
      fs.writeFileSync(file, JSON.stringify({ ...base, port: broken }, null, 2));
      await commands.port(['6107', '--project', project.root]);
      assert.equal(readConfig(project.root).port, 6107, `port ${JSON.stringify(broken)} should be replaceable`);
    }
  });

  it('works as the real CLI process, in the argument order the desktop shell uses', () => {
    const project = makeProject();
    execFileSync(process.execPath, [CLI, 'port', '6098', '--project', project.root], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
    assert.equal(readConfig(project.root).port, 6098);
    assert.equal(backups(project.root).length, 1);

    let failed;
    try {
      execFileSync(process.execPath, [CLI, 'port', '6666', '--project', project.root], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
    } catch (error) {
      failed = error;
    }
    assert.equal(failed.status, 1, 'a blocked port exits non-zero');
    assert.match(String(failed.stderr), /--port/);
    assert.equal(readConfig(project.root).port, 6098, 'the refused run left the config alone');
  });
});
