import { describe, expect, it } from 'vitest';
import { type LaneDraft, type SettingsDrafts, toDrafts, toRaw, validateDrafts } from './settingsForm';

const exampleConfig = {
  name: 'My Game',
  port: 6097,
  dataDir: '.questboard-data',
  events: '.questboard-data/events.jsonl',
  registry: '.questboard-data/registry.jsonl',
  lockFile: '.questboard-data/dispatch.lock',
  briefs: {
    dispatchDirs: ['docs/briefs'],
    ownerDirs: ['docs/design'],
    packagePattern: '^[A-Z]+(?:-[A-Z]+)*-\\d+[A-Z]?',
    fileListHeading: '^#{1,6}\\s*files you may (edit|touch)',
    recentDays: 7,
  },
  reviewPages: { dir: 'docs/review' },
  lanes: {
    codex: {
      run: [
        'node', 'scripts/run-worker.mjs', '--lane', 'codex', '--name', '{name}',
        '--brief', '{brief}', '--model', '{model}', '--variant', '{variant}',
        '--package', '{package}', '--', 'codex', 'exec', '-m', '{model}',
      ],
      outputDir: '.questboard-data/workers/codex',
    },
    claude: {
      run: [
        'node', 'scripts/run-worker.mjs', '--lane', 'claude', '--name', '{name}',
        '--brief', '{brief}', '--model', '{model}', '--variant', '{variant}',
        '--package', '{package}', '--', 'claude', '--print', '--model', '{model}',
      ],
      outputDir: '.questboard-data/workers/claude',
      editCounter: 'stream-json',
    },
    'claude-review': {
      run: [
        'node', 'scripts/run-worker.mjs', '--lane', 'claude-review', '--name', '{name}',
        '--brief', '{brief}', '--model', '{model}', '--variant', '{variant}',
        '--package', '{package}', '--', 'claude', '--print', '--model', '{model}',
      ],
      outputDir: '.questboard-data/workers/claude-review',
      editCounter: 'stream-json',
      serialize: true,
    },
    spaced: {
      run: ['node', 'tools/oc.js', 'new', '{package} {name}'],
      outputDir: '.questboard-data/workers/spaced',
    },
  },
  policy: {
    bannedModelPatterns: ['-fast(\\b|-)'],
    bannedAgents: [],
  },
};

function validDrafts(): SettingsDrafts {
  return toDrafts(exampleConfig);
}

// Indexing is `T | undefined` under noUncheckedIndexedAccess. These say out loud that the fixture is wrong
// if the lane is missing, instead of hiding it behind a non-null assertion.
function laneAt(drafts: SettingsDrafts, index: number): LaneDraft {
  const lane = drafts.lanes[index];
  if (!lane) throw new Error(`the fixture has no lane ${index}`);
  return lane;
}

function laneOf(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const lane = (raw.lanes as Record<string, Record<string, unknown> | undefined>)[id];
  if (!lane) throw new Error(`the result has no lane ${id}`);
  return lane;
}

describe('settingsForm toDrafts and toRaw', () => {
  it('round trips example config with space in lane run argument without corruption', () => {
    const drafts = toDrafts(exampleConfig);
    const roundTripped = toRaw(exampleConfig, drafts);
    expect(roundTripped).toEqual(exampleConfig);

    const spacedLane = laneOf(roundTripped, 'spaced') as { run: string[] };
    expect(spacedLane.run).toEqual(['node', 'tools/oc.js', 'new', '{package} {name}']);
    expect(spacedLane.run[3]).toBe('{package} {name}');
  });

  it('preserves unknown top-level keys', () => {
    const rawWithExtra = {
      ...exampleConfig,
      customPluginKey: { enabled: true, tags: ['alpha'] },
      unmanagedNumber: 42,
    };
    const drafts = toDrafts(rawWithExtra);
    const result = toRaw(rawWithExtra, drafts);
    expect(result.customPluginKey).toEqual({ enabled: true, tags: ['alpha'] });
    expect(result.unmanagedNumber).toBe(42);
  });

  it('clearing optional fields removes their keys', () => {
    const rawWithOptionals = {
      ...exampleConfig,
      bash: 'C:\\Program Files\\Git\\bin\\bash.exe',
      briefs: {
        ...exampleConfig.briefs,
        packagePattern: '^[A-Z]+',
        fileListHeading: '^# files',
      },
      lanes: {
        codex: {
          run: ['node', 'worker.js'],
          outputDir: 'out',
          api: 'http://localhost:8000',
          deliveryDir: 'deliv',
          defaultModel: 'claude-3-5',
          editCounter: 'stream-json',
          spacingMs: 500,
          env: { BASE_URL: 'http://test.local' },
          session: { run: ['node', 'sess.js'], saveTo: 'sess.json' },
        },
      },
    };

    const drafts = toDrafts(rawWithOptionals);
    drafts.project.bash = '';
    drafts.review.dir = '';
    drafts.briefs.packagePattern = '';
    drafts.briefs.fileListHeading = '';
    const onlyLane = laneAt(drafts, 0);
    onlyLane.api = '';
    onlyLane.deliveryDir = '';
    onlyLane.defaultModel = '';
    onlyLane.editCounter = '';
    onlyLane.spacingMs = '';
    onlyLane.env = '';
    onlyLane.sessionRun = [];
    onlyLane.sessionSaveTo = '';

    const res = toRaw(rawWithOptionals, drafts);
    expect('bash' in res).toBe(false);
    expect('reviewPages' in res).toBe(false);
    const briefsObj = res.briefs as Record<string, unknown>;
    expect('packagePattern' in briefsObj).toBe(false);
    expect('fileListHeading' in briefsObj).toBe(false);

    const laneObj = laneOf(res, 'codex');
    expect('api' in laneObj).toBe(false);
    expect('deliveryDir' in laneObj).toBe(false);
    expect('defaultModel' in laneObj).toBe(false);
    expect('editCounter' in laneObj).toBe(false);
    expect('spacingMs' in laneObj).toBe(false);
    expect('env' in laneObj).toBe(false);
    expect('session' in laneObj).toBe(false);
  });
});

describe('settingsForm validateDrafts rules', () => {
  it('rule 1: name not empty', () => {
    const d = validDrafts();
    d.project.name = '  ';
    expect(validateDrafts(d)['project.name']).toMatch(/项目名称不能为空/);
    d.project.name = 'Quest Project';
    expect(validateDrafts(d)['project.name']).toBeUndefined();
  });

  it('rule 2: port an integer 1–65535', () => {
    const d = validDrafts();
    for (const bad of ['', '0', '65536', 'abc', '80.5', '-1']) {
      d.project.port = bad;
      expect(validateDrafts(d)['project.port']).toMatch(/端口/);
    }
    d.project.port = '8080';
    expect(validateDrafts(d)['project.port']).toBeUndefined();
  });

  it('rule 3: at least one lane', () => {
    const d = validDrafts();
    d.lanes = [];
    expect(validateDrafts(d).lanes).toMatch(/至少需要配置一条通道/);
  });

  it('rule 4: every lane id matching ^[a-z][a-z0-9-]{0,31}$ and unique', () => {
    const d = validDrafts();
    const first = laneAt(d, 0);
    for (const badId of ['', 'Codex', '-codex', '0codex', 'codex_lane', 'a'.repeat(33)]) {
      first.id = badId;
      expect(validateDrafts(d)[`lanes.0.id`]).toBeDefined();
    }
    first.id = 'codex';
    laneAt(d, 1).id = 'codex';
    expect(validateDrafts(d)[`lanes.1.id`]).toMatch(/重复/);
  });

  it('rule 5: every lane run non-empty with no blank argument', () => {
    const d = validDrafts();
    const lane = laneAt(d, 0);
    lane.run = [];
    expect(validateDrafts(d)[`lanes.0.run`]).toMatch(/执行命令不能为空/);

    lane.run = ['node', '  ', 'arg'];
    expect(validateDrafts(d)[`lanes.0.run`]).toMatch(/空白/);

    lane.run = ['node', 'worker.js', '{name}'];
    expect(validateDrafts(d)[`lanes.0.run`]).toBeUndefined();
  });

  it('rule 6: spacingMs a non-negative integer when set', () => {
    const d = validDrafts();
    const lane = laneAt(d, 0);
    for (const bad of ['-1', 'abc', '1.5']) {
      lane.spacingMs = bad;
      expect(validateDrafts(d)[`lanes.0.spacingMs`]).toMatch(/非负整数/);
    }
    lane.spacingMs = '0';
    expect(validateDrafts(d)[`lanes.0.spacingMs`]).toBeUndefined();
    lane.spacingMs = '250';
    expect(validateDrafts(d)[`lanes.0.spacingMs`]).toBeUndefined();
    lane.spacingMs = '';
    expect(validateDrafts(d)[`lanes.0.spacingMs`]).toBeUndefined();
  });

  it('rule 7: editCounter one of patch, stream-json when set', () => {
    const d = validDrafts();
    const lane = d.lanes[0];
    if (!lane) throw new Error('validDrafts must provide one lane');
    lane.editCounter = 'other';
    expect(validateDrafts(d)[`lanes.0.editCounter`]).toMatch(/patch 或 stream-json/);

    for (const accepted of ['patch', 'stream-json', '']) {
      lane.editCounter = accepted;
      expect(validateDrafts(d)[`lanes.0.editCounter`]).toBeUndefined();
    }
  });

  it('rule 8: recentDays a positive integer', () => {
    const d = validDrafts();
    for (const bad of ['', '0', '-5', 'abc', '3.14']) {
      d.briefs.recentDays = bad;
      expect(validateDrafts(d)['briefs.recentDays']).toMatch(/正整数/);
    }
    d.briefs.recentDays = '14';
    expect(validateDrafts(d)['briefs.recentDays']).toBeUndefined();
  });

  it('rule 10: a serve command needs api, no blank argument and no placeholder, and round trips', () => {
    const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', serve: ['opencode', 'serve', '--port', '6096'] } } };
    const d = toDrafts(raw);
    expect(laneAt(d, 0).serve).toEqual(['opencode', 'serve', '--port', '6096']);
    expect(toRaw(raw, d)).toEqual(raw);
    expect(validateDrafts(d)['lanes.0.serve']).toBeUndefined();

    const lane = laneAt(d, 0);
    lane.serve = ['opencode', ' '];
    expect(validateDrafts(d)['lanes.0.serve']).toMatch(/空白/);
    lane.serve = ['opencode', '{name}'];
    expect(validateDrafts(d)['lanes.0.serve']).toMatch(/占位符/);
    lane.serve = ['opencode', 'serve'];
    lane.api = '';
    expect(validateDrafts(d)['lanes.0.serve']).toMatch(/api/);
    lane.serve = [];
    expect('serve' in laneOf(toRaw(raw, d), 'oc')).toBe(false);
  });

  it('rule 9: each lane env parsed with parseCardEnv', () => {
    const d = validDrafts();
    const lane = d.lanes[0];
    if (!lane) throw new Error('validDrafts must provide one lane');
    lane.env = 'no_equal_sign_here';
    expect(validateDrafts(d)[`lanes.0.env`]).toBeDefined();

    lane.env = 'KEY=sk-abcdef1234567890';
    expect(validateDrafts(d)[`lanes.0.env`]).toMatch(/密钥/);

    lane.env = 'BASE_URL=https://api.example.com\nMODEL_TIMEOUT=30';
    expect(validateDrafts(d)[`lanes.0.env`]).toBeUndefined();
  });
});
