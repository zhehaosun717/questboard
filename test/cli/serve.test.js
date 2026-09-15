// F1 (QB-FB-PRODUCT-PORTS revision 2): `questboard serve --port <bad>` used to bind anyway —
// `options.port || options.config.port` in src/server/server.js silently fell back to the config's own
// port on a falsy override (0, NaN from 'abc'), and never checked the range or the browser-unsafe list at
// all. These tests exercise the actual `serve` boundary (not just the pure helper) so a regression there
// would fail loudly instead of just failing a duplicated unit test.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commands, parsePortOption } from '../../src/cli/commands.js';
import { makeProject } from '../helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
const INVALID_PORTS = ['6666', '0', 'abc', '6097.5', '70000'];

describe('questboard serve --port validation', () => {
  it('parsePortOption keeps an omitted override as the default, and validates a given one the same way the config file port is', () => {
    assert.equal(parsePortOption(undefined), undefined);
    assert.equal(parsePortOption('45231'), 45231);
    assert.equal(parsePortOption('6097'), 6097);
    for (const bad of [...INVALID_PORTS, '', ' ', '-1', 'NaN', 'Infinity', '1e3']) {
      assert.throws(() => parsePortOption(bad), /--port/, `--port ${JSON.stringify(bad)} should be refused`);
    }
  });

  it('commands.serve refuses an invalid --port before startServer is ever called — no fallback, no bind', async () => {
    const project = makeProject();
    for (const bad of INVALID_PORTS) {
      await assert.rejects(
        commands.serve(['--project', project.root, '--port', bad]),
        (error) => error.message.includes('--port') && /浏览器|必须是/.test(error.message),
        `--port ${bad} should be refused before the server starts`,
      );
    }
  });

  // A real subprocess boundary check without probing any port: if the fix regressed back to the old
  // `options.port || options.config.port` fallback, `serve --port 0` (or the blocked 6666) would actually
  // bind and keep listening, and this synchronous call would hang until the timeout kills it — visible here
  // as `error.killed === true`, not the fast, self-terminated non-zero exit a correct refusal produces.
  it('the real CLI process exits on a refused --port instead of binding and hanging', () => {
    const project = makeProject();
    for (const bad of ['6666', '0', 'abc']) {
      let error;
      try {
        execFileSync(process.execPath, [CLI, 'serve', '--project', project.root, '--port', bad], { encoding: 'utf8', stdio: 'pipe', timeout: 4000 });
        assert.fail(`--port ${bad} should have made serve exit non-zero`);
      } catch (err) {
        error = err;
      }
      assert.notEqual(error.killed, true, `--port ${bad}: process had to be killed after the timeout, meaning it bound and kept listening instead of refusing`);
      assert.match(String(error.stderr), /--port/, `--port ${bad}: stderr should name the flag`);
    }
  });
});
