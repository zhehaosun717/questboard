// `roster import` used to overwrite the whole machine roster: one stale card from an exported file wiped
// the owner's per-card env (the OC_BASE incident) and could flip a status the owner had moved on from.
// These tests pin the new contract: merge by card id; validate the whole plan before writing anything;
// back up the exact previous roster; dry runs leak only counts and field names; only --replace --force
// erases; and a file never overrules a newer local status. Temporary fixture homes only — never ~/.questboard.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { commands } from '../../src/cli/commands.js';
import { loadRoster } from '../../src/core/roster.js';
import { StatusLog } from '../../src/core/status.js';
import { tmpDir } from '../helpers.js';

const homeFixture = (adventurers) => {
  const dir = tmpDir('qb-import-home-');
  const home = {
    dir,
    roster: path.join(dir, 'roster.json'),
    status: path.join(dir, 'status.jsonl'),
    cards: () => loadRoster(home.roster).adventurers,
    card: (id) => home.cards().find((a) => a.id === id),
    backups: () => fs.readdirSync(dir).filter((name) => name.includes('.bak-')),
    bytes: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null),
  };
  if (adventurers) fs.writeFileSync(home.roster, JSON.stringify({ adventurers }));
  return home;
};

const legacyFile = (adventurers, policy) => {
  const file = path.join(tmpDir('qb-import-legacy-'), 'roster.json');
  fs.writeFileSync(file, JSON.stringify(policy ? { policy, adventurers } : { adventurers }));
  return file;
};

const card = (id, over = {}) => ({ id, name: `卡 ${id}`, provider: '厂商', lane: 'codex', model: `模型 ${id}`, family: `家族 ${id}`, ...over });
const ownerRecord = (id, status, at) => `${JSON.stringify({ at, adventurerId: id, status, reason: 'owner call', setBy: 'owner' })}\n`;
const lastRecord = (home, id) => (fs.existsSync(home.status) ? fs.readFileSync(home.status, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.adventurerId === id).pop();

// Calls commands.roster in-process (like roster-init.test.js) against a fixture QUESTBOARD_HOME,
// capturing stdout; returns { output, error }.
async function rosterImport(home, args) {
  const previousHome = process.env.QUESTBOARD_HOME;
  const previousWrite = process.stdout.write;
  const lines = [];
  process.env.QUESTBOARD_HOME = home.dir;
  process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    await commands.roster(['import', ...args]);
    return { output: lines.join(''), error: undefined };
  } catch (error) {
    return { output: lines.join(''), error };
  } finally {
    process.stdout.write = previousWrite;
    if (previousHome === undefined) delete process.env.QUESTBOARD_HOME;
    else process.env.QUESTBOARD_HOME = previousHome;
  }
}

describe('roster import merges by card id instead of replacing', () => {
  it('keeps local env, variant and unrelated cards when the file omits them', async () => {
    const home = homeFixture([
      card('codex-astra', { env: { OC_BASE_URL: 'https://gw.example.com' }, variant: 'high', agent: 'build' }),
      card('local-only', { provider: '别家' }),
    ]);
    const rosterBefore = home.bytes(home.roster);
    const { output, error } = await rosterImport(home, [legacyFile([card('codex-astra')]), '--force']);
    assert.equal(error, undefined, output);
    const astra = home.card('codex-astra');
    assert.deepEqual(astra.env, { OC_BASE_URL: 'https://gw.example.com' }, 'a file that omits env must not drop the local env');
    assert.equal(astra.variant, 'high', 'a file that omits variant must not drop it');
    assert.equal(astra.agent, 'build');
    assert.ok(home.card('local-only'), 'cards the file never mentions are kept, not erased');
    assert.match(output, /1 local cards kept/);
    assert.equal(home.bytes(home.status), null, 'a clean merge with no statuses in the file appends nothing');
    assert.deepEqual(home.backups(), [], 'a merge that changes nothing is not written, and needs no backup');
    void rosterBefore;
  });

  it('overlays only explicitly supplied values, and merges env per key', async () => {
    const home = homeFixture([card('agi-1', { env: { OC_BASE_URL: 'https://old.example.com', KEEP_MODEL: 'x' } })]);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1', { model: '新模型', env: { OC_BASE_URL: 'https://new.example.com' } })]), '--force']);
    assert.equal(error, undefined);
    const agi = home.card('agi-1');
    assert.equal(agi.model, '新模型', 'an explicitly supplied value is overlaid');
    assert.deepEqual(agi.env, { OC_BASE_URL: 'https://new.example.com', KEEP_MODEL: 'x' }, 'the supplied key updates, the other key survives');
    assert.equal(agi.variant, undefined, 'no blanket high default for a card that never had a variant');
  });

  it('adds unknown cards after the existing ones', async () => {
    const home = homeFixture([card('first')]);
    const { output, error } = await rosterImport(home, [legacyFile([card('first'), card('second')]), '--force']);
    assert.equal(error, undefined, output);
    assert.match(output, /1 added/);
    assert.deepEqual(home.cards().map((a) => a.id), ['first', 'second']);
  });

  it('never invents a variant or model capability for imported cards', async () => {
    const home = homeFixture([card('plain')]);
    await rosterImport(home, [legacyFile([card('plain', { model: '换' })]), '--force']);
    assert.ok(home.cards().every((a) => a.variant === undefined), 'imported cards keep having no variant');
  });
});

describe('roster import validates before touching any file', () => {
  it('a dry run names fields only and writes nothing', async () => {
    const home = homeFixture([card('agi-1', { env: { OC_BASE_URL: 'https://local.example.com' }, variant: 'high' })]);
    const rosterBefore = home.bytes(home.roster);
    const file = legacyFile([card('agi-1', { model: '换模型', env: { OC_BASE_URL: 'https://other.example.com', EXTRA_MODEL: 'v' }, status: 'limited', statusChangedAt: '2026-09-01T00:00:00.000Z' }), card('brand-new')]);
    const { output, error } = await rosterImport(home, [file, '--dry-run']);
    assert.equal(error, undefined, output);
    assert.match(output, /merge plan/, 'the preview says which mode it planned');
    assert.match(output, /agi-1: model, env/, 'changed field names are reported');
    assert.match(output, /brand-new/, 'added ids are reported');
    assert.ok(!output.includes('https://'), 'no values in the preview');
    assert.ok(!output.includes('OC_BASE_URL') && !output.includes('EXTRA_MODEL'), 'no env key names in the preview');
    assert.equal(home.bytes(home.roster), rosterBefore);
    assert.equal(home.bytes(home.status), null, 'a dry run appends no status records either');
    assert.deepEqual(home.backups(), [], 'a dry run writes no backup either');
  });

  it('a bad status or a secret-shaped env in the file aborts before anything is written', async () => {
    const home = homeFixture([card('agi-1')]);
    fs.writeFileSync(home.status, '{"at":"2026-09-01T00:00:00.000Z","adventurerId":"agi-1","status":"paused","reason":"owner","setBy":"owner"}\n');
    const rosterBefore = home.bytes(home.roster);
    const statusBefore = home.bytes(home.status);
    const badStatus = await rosterImport(home, [legacyFile([card('agi-1', { status: 'sleeping' })]), '--force']);
    assert.match(String(badStatus.error), /status must be one of/, 'the failure names the bad status');
    const secretEnv = await rosterImport(home, [legacyFile([card('agi-1', { env: { OC_MODEL: 'sk-live-abcdef' } })]), '--force']);
    assert.match(String(secretEnv.error), /roster/, 'the secret-shaped env fails validation');
    assert.equal(home.bytes(home.roster), rosterBefore, 'the roster is untouched by either failure');
    assert.equal(home.bytes(home.status), statusBefore, 'and the status log never got a partial record');
    assert.deepEqual(home.backups(), [], 'and no backup of a write that never happened');
  });

  it('a malformed existing roster fails loudly instead of being treated as empty', async () => {
    const home = homeFixture();
    fs.writeFileSync(home.roster, '{"adventurers": "not a list"}');
    const broken = home.bytes(home.roster);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1')]), '--force']);
    assert.match(String(error), /roster/);
    assert.equal(home.bytes(home.roster), broken, 'the malformed file is not silently replaced');
  });

  it('an unparseable import file is named, not swallowed', async () => {
    const home = homeFixture();
    const file = path.join(tmpDir('qb-import-bad-'), 'roster.json');
    fs.writeFileSync(file, '{"adventurers": [oops');
    const { error } = await rosterImport(home, [file]);
    assert.match(String(error), /not valid JSON/);
    assert.equal(home.bytes(home.roster), null, 'a bad file never creates a roster');
  });
});

describe('roster import backups and explicit modes', () => {
  it('without --force a present roster is refused, with help naming all three modes', async () => {
    const home = homeFixture([card('agi-1')]);
    const rosterBefore = home.bytes(home.roster);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1', { model: '换' })])]);
    assert.match(String(error), /pass --force/);
    assert.match(String(error), /--replace --force/, 'the refusal explains merge vs replace');
    assert.equal(home.bytes(home.roster), rosterBefore);
    assert.deepEqual(home.backups(), []);
  });

  it('backs up the exact previous roster, recoverably, before a real merge', async () => {
    const home = homeFixture([card('agi-1', { env: { KEEP_MODEL: 'yes' } })]);
    const previous = home.bytes(home.roster);
    const { output, error } = await rosterImport(home, [legacyFile([card('agi-1', { model: '换模型' })]), '--force']);
    assert.equal(error, undefined, output);
    assert.match(output, /backup/);
    const [backup] = home.backups();
    assert.ok(backup && /-merge$/.test(backup));
    assert.equal(home.bytes(path.join(home.dir, backup)), previous, 'the backup is the previous file exactly');
    fs.copyFileSync(path.join(home.dir, backup), home.roster);
    assert.equal(home.bytes(home.roster), previous, 'restoring it recovers the old roster');
  });

  it('--replace is the explicit full swap and always backs up; plain --force never erases', async () => {
    const home = homeFixture([card('local-only'), card('agi-1')]);
    const refused = await rosterImport(home, [legacyFile([card('agi-1')]), '--replace']);
    assert.match(String(refused.error), /pass --force/, '--replace still needs the confirmation');
    assert.ok(home.card('local-only'), 'and without it nothing was erased');
    const merged = await rosterImport(home, [legacyFile([card('agi-1')]), '--force']);
    assert.equal(merged.error, undefined, merged.output);
    assert.ok(home.card('local-only'), 'a plain --force merge keeps local-only cards');
    const replaced = await rosterImport(home, [legacyFile([card('agi-1')]), '--replace', '--force']);
    assert.equal(replaced.error, undefined, replaced.output);
    assert.match(replaced.output, /erased/, 'the run states what it erased');
    assert.deepEqual(home.cards().map((a) => a.id), ['agi-1']);
    assert.ok(home.backups().some((b) => b.includes('-replace')), 'a replace always leaves a recoverable backup');
  });

  it('two changing imports land two backups even when their names would otherwise collide', async () => {
    // Force the collision deterministically instead of racing the real clock: pre-create the exact
    // filename the next backup would use (same-second timestamp, attempt 1), then import for real.
    const home = homeFixture([card('agi-1')]);
    const before = home.bytes(home.roster);
    const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
    const collidingName = `roster.json.bak-${timestamp}-1-merge`;
    const decoy = 'this file must survive untouched\n';
    fs.writeFileSync(path.join(home.dir, collidingName), decoy);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1', { model: '换' })]), '--force']);
    assert.equal(error, undefined);
    const backups = home.backups();
    assert.ok(backups.includes(collidingName), 'the pre-existing backup was not overwritten');
    assert.equal(home.bytes(path.join(home.dir, collidingName)), decoy, 'its bytes are exactly what they were');
    const real = backups.find((b) => b !== collidingName);
    assert.ok(real, 'a second backup was written under a different name');
    assert.equal(home.bytes(path.join(home.dir, real)), before, 'the real backup holds the actual previous roster');
  });
});

describe('roster import never overrides a card that already has a status', () => {
  it('a card the owner explicitly un-paused stays un-paused, however the file is re-touched', async () => {
    const home = homeFixture([card('agi-1')]);
    fs.writeFileSync(home.status, ownerRecord('agi-1', 'available', new Date().toISOString()));
    const statusBefore = home.bytes(home.status);
    const file = legacyFile([card('agi-1', { status: 'paused', statusChangedAt: '2020-01-01T00:00:00.000Z' })]);
    const first = await rosterImport(home, [file, '--force']);
    assert.equal(first.error, undefined, first.output);
    assert.match(first.output, /status kept as-is/, 'the stale record is skipped out loud');
    assert.equal(home.bytes(home.status), statusBefore, 'the owner decision stands untouched');
    assert.equal(new StatusLog(home.status).current().get('agi-1').status, 'available');
    // Re-copy/checkout/edit changes the file's mtime; a re-import must still not re-pause it (blocker 1).
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8'));
    const touched = new Date(Date.now() + 5000);
    fs.utimesSync(file, touched, touched);
    const second = await rosterImport(home, [file, '--force']);
    assert.equal(second.error, undefined, second.output);
    assert.equal(home.bytes(home.status), statusBefore, 'a newer mtime is not a newer owner decision');
    assert.equal(new StatusLog(home.status).current().get('agi-1').status, 'available');
  });

  it('a current paused is not silently replaced by an undated, merely-newer-looking limited or broke', async () => {
    const home = homeFixture([card('agi-1')]);
    fs.writeFileSync(home.status, ownerRecord('agi-1', 'paused', new Date(Date.now() - 3600_000).toISOString()));
    const statusBefore = home.bytes(home.status);
    // No statusChangedAt on the card: the incoming record's date is only the file's own (very recent) mtime.
    const { output, error } = await rosterImport(home, [legacyFile([card('agi-1', { status: 'limited' })]), '--force']);
    assert.equal(error, undefined, output);
    assert.equal(home.bytes(home.status), statusBefore, "mtime being 'newer' than the owner's paused-at does not win");
    assert.equal(new StatusLog(home.status).current().get('agi-1').status, 'paused');
  });

  it('an old available never unpauses, and legacy splits emit no record for it', async () => {
    const home = homeFixture([card('agi-1')]);
    fs.writeFileSync(home.status, ownerRecord('agi-1', 'paused', new Date().toISOString()));
    const statusBefore = home.bytes(home.status);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1', { status: 'available' })]), '--force']);
    assert.equal(error, undefined);
    assert.equal(home.bytes(home.status), statusBefore, "an old 'available' is not a status command");
    assert.equal(new StatusLog(home.status).current().get('agi-1').status, 'paused');
  });

  it('re-importing the same file is a no-op: no roster rewrite, no duplicate records', async () => {
    const home = homeFixture();
    const file = legacyFile([card('agi-1', { status: 'limited', note: '限额中' })]);
    const first = await rosterImport(home, [file]);
    assert.equal(first.error, undefined, first.output);
    assert.match(first.output, /imported 1 cards/, 'the original summary stays honest');
    const rosterAfterFirst = home.bytes(home.roster);
    const statusAfterFirst = home.bytes(home.status);
    assert.equal(new StatusLog(home.status).current().get('agi-1').status, 'limited', 'a first import still records what the file says');
    const again = await rosterImport(home, [file, '--force']);
    assert.match(again.output, /roster unchanged/);
    assert.equal(home.bytes(home.roster), rosterAfterFirst);
    assert.equal(home.bytes(home.status), statusAfterFirst, 'records are not appended twice');
    assert.deepEqual(home.backups(), [], 'an unchanged import never rewrites or backs up');
  });

  it('a card with no status history at all still gets its first imported status', async () => {
    const home = homeFixture([card('agi-1')]);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1', { status: 'broke', statusChangedAt: '2026-02-01T00:00:00.000Z' })]), '--force']);
    assert.equal(error, undefined);
    const record = lastRecord(home, 'agi-1');
    assert.equal(record.status, 'broke');
    assert.equal(record.at, '2026-02-01T00:00:00.000Z', 'a genuine per-card date is preserved exactly');
    assert.equal(record.reason, '', 'no undated-provenance note is added when the date is genuine');
  });

  it('a first import with no per-card date documents that the date is only a guess, not an owner decision', async () => {
    const home = homeFixture([card('agi-1')]);
    const { error } = await rosterImport(home, [legacyFile([card('agi-1', { status: 'limited', note: '没有单卡日期' })]), '--force']);
    assert.equal(error, undefined);
    const record = lastRecord(home, 'agi-1');
    assert.equal(record.status, 'limited');
    assert.match(record.reason, /没有单卡日期/, 'the original note survives');
    assert.match(record.reason, /估算/, 'the record says its date is an estimate, not a real decision moment');
  });
});

describe('roster import contains its diagnostics', () => {
  it('an unparseable import file never echoes file content, only says where', async () => {
    const home = homeFixture();
    const file = path.join(tmpDir('qb-import-bad-'), 'roster.json');
    fs.writeFileSync(file, '{"adventurers": [ "SECRET-VALUE-should-not-leak" oops');
    const { error } = await rosterImport(home, [file]);
    assert.match(String(error), /not valid JSON/);
    assert.ok(!String(error).includes('SECRET-VALUE-should-not-leak'), 'the parser is never allowed to quote file content back');
  });

  it("a malformed existing home roster's parse failure never echoes file content", async () => {
    const home = homeFixture();
    fs.writeFileSync(home.roster, '{"adventurers": [ "SECRET-HOME-should-not-leak" oops');
    const { error } = await rosterImport(home, [legacyFile([card('agi-1')]), '--force']);
    assert.match(String(error), /roster/i);
    assert.ok(!String(error).includes('SECRET-HOME-should-not-leak'), "the home roster's own content never reaches the message");
  });

  it('a real (non-dry-run) import reports counts and ids only, never note text or raw policy values', async () => {
    const home = homeFixture();
    const secretNote = 'owner 2026-09-12 SECRET-NOTE-should-not-print';
    const file = legacyFile([card('astra', { status: 'paused', note: secretNote })], { bannedModelPatterns: ['SECRET-PATTERN'], bannedAgents: ['SECRET-AGENT'] });
    const { output, error } = await rosterImport(home, [file, '--force']);
    assert.equal(error, undefined, output);
    assert.ok(!output.includes(secretNote), 'note text is never echoed on a real import either');
    assert.ok(!output.includes('SECRET-PATTERN') && !output.includes('SECRET-AGENT'), 'policy values are never echoed, only counts');
    assert.match(output, /astra/, 'the affected id is still named');
    assert.match(output, /1 banned model pattern/, 'policy is summarized by count');
  });
});

describe('roster import with project-allowed card env (round 6 M1)', () => {
  it('merges normally when an untouched existing card carries an env allowed only by some project list', async () => {
    const home = homeFixture([card('project-card', { env: { OC_AGENT: 'build' } })]);
    const file = legacyFile([card('incoming-card')]);
    const { output, error } = await rosterImport(home, [file, '--force']);
    assert.equal(error, undefined, output);
    assert.match(output, /imported 2 cards/);
    assert.equal(home.card('project-card').env.OC_AGENT, 'build');
    assert.ok(home.card('incoming-card'));
  });

  it('still refuses an incoming card whose env name is outside the allowed shapes, in Chinese', async () => {
    const home = homeFixture([]);
    const file = legacyFile([card('bad-card', { env: { MY_TOOL_FLAG: 'enabled' } })]);
    const { output, error } = await rosterImport(home, [file, '--force']);
    assert.ok(error, 'the import must be refused');
    assert.match(String(error), /不是卡片可以设置的/);
    assert.match(String(error), /MY_TOOL_FLAG/);
    assert.equal(home.bytes(home.roster), JSON.stringify({ adventurers: [] }), 'a refused import writes nothing');
  });
});

describe('roster import through the real CLI process (not just the in-process helper)', () => {
  const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'cli', 'questboard.js');
  const runCli = (args, env) => execFileSync(process.execPath, [CLI, 'roster', 'import', ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 20000 });

  it('a dry run and a real import both work end to end through argv, not just commands.roster()', () => {
    const dir = tmpDir('qb-import-cli-home-');
    const env = { QUESTBOARD_HOME: dir, HOME: dir, USERPROFILE: dir };
    const file = legacyFile([card('agi-1', { status: 'limited', statusChangedAt: '2026-03-01T00:00:00.000Z' })]);
    const dry = runCli([file, '--dry-run'], env);
    assert.match(dry, /merge plan/);
    assert.equal(fs.existsSync(path.join(dir, 'roster.json')), false, 'a dry run through the real process still writes nothing');
    const real = runCli([file], env);
    assert.match(real, /imported 1 cards/);
    assert.equal(loadRoster(path.join(dir, 'roster.json')).adventurers[0].id, 'agi-1');
    assert.equal(new StatusLog(path.join(dir, 'status.jsonl')).current().get('agi-1').status, 'limited');
    assert.throws(() => runCli([file], env), /pass --force/, 'a second run through the real process still needs --force');
  });
});

describe('roster import-opencode (FB2-07 item 2)', () => {
  const verboseFile = (records) => {
    const file = path.join(tmpDir('qb-oc-models-'), 'models.txt');
    fs.writeFileSync(file, records.map((r) => `${r.providerID || 'opencode'}/${r.id}\n${JSON.stringify(r, null, 2)}`).join('\n'));
    return file;
  };
  const ocRec = (over = {}) => ({
    id: 'm1', providerID: 'opencode', name: 'M One', family: 'm',
    status: 'active', cost: { input: 0, output: 0 },
    capabilities: { toolcall: true, input: { text: true }, output: { text: true } },
    ...over,
  });
  async function importOpencode(home, args) {
    const previousHome = process.env.QUESTBOARD_HOME;
    const previousWrite = process.stdout.write;
    const lines = [];
    process.env.QUESTBOARD_HOME = home.dir;
    process.stdout.write = (chunk) => { lines.push(String(chunk)); return true; };
    try {
      await commands.roster(['import-opencode', ...args]);
      return { output: lines.join(''), error: undefined };
    } catch (error) {
      return { output: lines.join(''), error };
    } finally {
      process.stdout.write = previousWrite;
      if (previousHome === undefined) delete process.env.QUESTBOARD_HOME;
      else process.env.QUESTBOARD_HOME = previousHome;
    }
  }

  it('imports with the capability filter on by default and reports kept/dropped counts', async () => {
    const home = homeFixture([]);
    const file = verboseFile([
      ocRec(),
      ocRec({ id: 'img', name: 'Img', capabilities: { toolcall: false, input: { text: true }, output: { image: true } } }),
      ocRec({ id: 'old', name: 'Old', status: 'deprecated' }),
    ]);
    const { output, error } = await importOpencode(home, ['--file', file, '--lane', 'oc']);
    assert.equal(error, undefined, output);
    assert.match(output, /留下 2 张/);
    assert.match(output, /过滤掉 1 个/);
    assert.match(output, /img/);
    assert.equal(home.card('opencode-m1').verified, 'ok');
    assert.equal(home.card('opencode-m1').billing, 'free');
    assert.equal(home.card('opencode-old').verified, 'broken');
    assert.equal(home.card('opencode-img'), undefined, 'filtered out');
  });

  it('--no-filter keeps the non-tool model', async () => {
    const home = homeFixture([]);
    const file = verboseFile([ocRec({ id: 'img', capabilities: { toolcall: false, input: { text: true }, output: { image: true } } })]);
    const { error } = await importOpencode(home, ['--file', file, '--lane', 'oc', '--no-filter']);
    assert.equal(error, undefined);
    assert.ok(home.card('opencode-img'));
  });

  it('refuses without --lane and names what is missing', async () => {
    const home = homeFixture([]);
    const { error } = await importOpencode(home, ['--file', verboseFile([ocRec()])]);
    assert.ok(error);
    assert.match(String(error.message), /--lane/);
  });

  it('re-importing never clobbers a local env or variant on the same card id', async () => {
    const home = homeFixture([card('opencode-m1', { env: { OC_BASE_URL: 'https://gw.example.com' }, variant: 'high' })]);
    const { error } = await importOpencode(home, ['--file', verboseFile([ocRec()]), '--lane', 'oc']);
    assert.equal(error, undefined);
    const merged = home.card('opencode-m1');
    assert.deepEqual(merged.env, { OC_BASE_URL: 'https://gw.example.com' });
    assert.equal(merged.variant, 'high');
    assert.equal(merged.verified, 'ok', 'the fresh verification fact still lands');
  });
});
