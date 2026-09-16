import { describe, expect, it } from 'vitest';
import { describeMalformedHealth, OPENCODE_HEALTH_PRESET, type LaneDraft, type SettingsDrafts, toDrafts, toRaw, validateDrafts } from './settingsForm';

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

  it('round trips the feedback-38 policy fields and drops them when cleared', () => {
    const rawWithPolicy = {
      ...exampleConfig,
      policy: {
        ...exampleConfig.policy,
        stallAfterMinutes: 45,
        laneConcurrency: { codex: 2, claude: 1 },
        defaultLane: 'codex',
        defaultCard: 'oc-mimo',
        bouncePatterns: [{ code: 'quota_5h', pattern: 'resets (at|in)', label: '额度用尽' }],
        unknownPolicyKey: { keep: true },
      },
    };
    const drafts = toDrafts(rawWithPolicy);
    expect(drafts.policy.stallAfterMinutes).toBe('45');
    expect(drafts.policy.laneConcurrency).toEqual([{ lane: 'codex', limit: '2' }, { lane: 'claude', limit: '1' }]);
    expect(drafts.policy.defaultLane).toBe('codex');
    expect(drafts.policy.defaultCard).toBe('oc-mimo');
    expect(drafts.policy.bouncePatterns).toEqual([{ code: 'quota_5h', pattern: 'resets (at|in)', label: '额度用尽' }]);
    expect(toRaw(rawWithPolicy, drafts)).toEqual(rawWithPolicy);
    const cleared = toRaw(rawWithPolicy, {
      ...drafts,
      policy: { ...drafts.policy, stallAfterMinutes: '', laneConcurrency: [], defaultLane: '', defaultCard: '', bouncePatterns: [] },
    });
    expect(cleared.policy).toEqual({ bannedModelPatterns: ['-fast(\\b|-)'], bannedAgents: [], unknownPolicyKey: { keep: true } });
  });

  it('validates feedback-38 policy fields in Chinese, keyed the way the section reads them', () => {
    expect(validateDrafts(validDrafts())).toEqual({});
    const drafts = validDrafts();
    const bad = {
      ...drafts,
      policy: {
        ...drafts.policy,
        stallAfterMinutes: '0',
        laneConcurrency: [{ lane: 'ghost', limit: 'x' }, { lane: 'codex', limit: '2' }, { lane: 'codex', limit: '2' }],
        defaultLane: 'ghost',
        defaultCard: 'Nope!',
        bouncePatterns: [{ code: 'Bad Code', pattern: '(', label: '' }],
      },
    };
    const errors = validateDrafts(bad);
    expect(errors['policy.stallAfterMinutes']).toBe('停摆阈值必须是正整数（分钟）');
    expect(errors['policy.laneConcurrency.0.lane']).toBe('通道「ghost」不在接入方式里');
    expect(errors['policy.laneConcurrency.0.limit']).toBe('并发上限必须是正整数');
    expect(errors['policy.laneConcurrency.2.lane']).toBe('通道「codex」重复');
    expect(errors['policy.defaultLane']).toBe('默认通道「ghost」不在接入方式里');
    expect(errors['policy.defaultCard']).toBe('默认卡 ID 只能用小写字母、数字和连字符，1-48 个字符');
    expect(errors['policy.bouncePatterns.0.code']).toBe('code 只能用小写字母、数字、下划线，且以字母开头');
    expect(errors['policy.bouncePatterns.0.pattern']).toMatch(/^正则不合法：/);
    expect(errors['policy.bouncePatterns.0.label']).toBe('标签不能为空');
    const ok = {
      ...drafts,
      policy: {
        ...drafts.policy,
        stallAfterMinutes: '45',
        laneConcurrency: [{ lane: 'codex', limit: '2' }],
        defaultLane: 'codex',
        defaultCard: 'oc-mimo',
        bouncePatterns: [{ code: 'quota_5h', pattern: 'resets (at|in)', label: '额度用尽' }],
      },
    };
    expect(validateDrafts(ok)).toEqual({});
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
    expect(validateDrafts(d).lanes).toMatch(/至少需要配置一种接入方式/);
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

  it('rule 11: health path relative to api, JSON object, needs api, empty removes it', () => {
    const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096' } } };
    const d = toDrafts(raw);
    const lane = laneAt(d, 0);
    expect(lane.healthPath).toBe('');
    expect(lane.healthJson).toBe('');
    expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();

    lane.healthPath = 'http://evil.example/health';
    expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/相对路径/);
    lane.healthPath = '//evil.example/health';
    expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/相对路径/);
    lane.healthPath = '/global/health';
    expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();

    lane.healthJson = 'not json';
    expect(validateDrafts(d)['lanes.0.healthJson']).toMatch(/JSON/);
    lane.healthJson = '[1, 2]';
    expect(validateDrafts(d)['lanes.0.healthJson']).toMatch(/对象/);
    lane.healthJson = '{"healthy":true}';
    expect(validateDrafts(d)['lanes.0.healthJson']).toBeUndefined();

    const saved = toRaw(raw, d);
    expect(laneOf(saved, 'oc').health).toEqual({ path: '/global/health', json: { healthy: true } });

    lane.api = '';
    expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/api/);

    lane.api = 'http://127.0.0.1:6096';
    lane.healthPath = '';
    expect(validateDrafts(d)['lanes.0.healthJson']).toMatch(/健康检查路径/);
    lane.healthJson = '';
    expect('health' in laneOf(toRaw(raw, d), 'oc')).toBe(false);
  });

  it('rule 12: opening an existing health contract round trips and survives an unrelated edit', () => {
    const raw = {
      ...exampleConfig,
      lanes: {
        oc: {
          run: ['node', 'tools/oc.js'],
          api: 'http://127.0.0.1:6096',
          health: { path: '/global/health', json: { healthy: true } },
        },
      },
    };
    const d = toDrafts(raw);
    const lane = laneAt(d, 0);
    expect(lane.healthPath).toBe('/global/health');
    expect(JSON.parse(lane.healthJson)).toEqual({ healthy: true });
    expect(toRaw(raw, d)).toEqual(raw);

    lane.deliveryDir = 'somewhere-else';
    const saved = toRaw(raw, d);
    expect(laneOf(saved, 'oc').health).toEqual({ path: '/global/health', json: { healthy: true } });
    expect(laneOf(saved, 'oc').deliveryDir).toBe('somewhere-else');
  });

  it('rule 13: the OpenCode preset fills in a known-good contract', () => {
    expect(OPENCODE_HEALTH_PRESET.path.startsWith('/')).toBe(true);
    expect(JSON.parse(OPENCODE_HEALTH_PRESET.json)).toEqual({ healthy: true });
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

  it('rule 14: health path/api validation matches the E-service contract (config.js)', () => {
    const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096' } } };
    const d = toDrafts(raw);
    const lane = laneAt(d, 0);

    // Rejected by the service: a backslash anywhere, or a second leading slash.
    lane.healthPath = '/a\\b';
    expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/相对路径/);
    lane.healthPath = '/\\evil.example';
    expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/相对路径/);

    // Accepted by the service: a query string is still a local path even if it contains "://".
    lane.healthPath = '/health?next=http://x';
    expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();
    // A fragment is also accepted (the service does not reject it).
    lane.healthPath = '/health#frag';
    expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();

    lane.healthPath = '/global/health';

    // api must not end in /, or contain ? or #, once health is set — it is joined directly with health.path.
    lane.api = 'http://127.0.0.1:6096/';
    expect(validateDrafts(d)['lanes.0.api']).toMatch(/\//);
    lane.api = 'http://127.0.0.1:6096?x=1';
    expect(validateDrafts(d)['lanes.0.api']).toMatch(/\?/);
    lane.api = 'http://127.0.0.1:6096#f';
    expect(validateDrafts(d)['lanes.0.api']).toMatch(/#/);

    // The same api is fine without health.
    lane.healthPath = '';
    expect(validateDrafts(d)['lanes.0.api']).toBeUndefined();
  });

  it('rule 15: health.json expected values must be primitives, and unknown health keys survive a save', () => {
    const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096' } } };
    const d = toDrafts(raw);
    const lane = laneAt(d, 0);
    lane.healthPath = '/h';

    lane.healthJson = '{"a":{"b":1}}';
    expect(validateDrafts(d)['lanes.0.healthJson']).toMatch(/^期望字段 a /);
    lane.healthJson = '{"a":[1]}';
    expect(validateDrafts(d)['lanes.0.healthJson']).toMatch(/^期望字段 a /);
    lane.healthJson = '{"healthy":true,"n":null,"tries":3,"label":"ok"}';
    expect(validateDrafts(d)['lanes.0.healthJson']).toBeUndefined();

    // An unrelated key already on the saved lane's health (e.g. a field this UI does not know about yet)
    // is not dropped just because path/json are rewritten.
    const rawWithExtra = {
      ...exampleConfig,
      lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: '/h', timeout: 5 } } },
    };
    const d2 = toDrafts(rawWithExtra);
    expect(laneAt(d2, 0).healthJson).toBe('');
    const saved = toRaw(rawWithExtra, d2);
    expect(laneOf(saved, 'oc').health).toEqual({ path: '/h', timeout: 5 });
  });

  it('rule 16: a health.json that is not an object (hand-edited file) is shown, not silently dropped', () => {
    const raw = {
      ...exampleConfig,
      lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: '/h', json: 'bad' } } },
    };
    const d = toDrafts(raw);
    const lane = laneAt(d, 0);
    // The bad value is visible as text, not silently turned into an empty field.
    expect(lane.healthJson).toBe('"bad"');
    // ...and it blocks the save with a visible error, instead of toRaw quietly writing `{path}` only.
    expect(validateDrafts(d)['lanes.0.healthJson']).toMatch(/对象/);
  });

  it('rule 18: renaming a lane id still finds its own original data, for unknown lane keys and unknown health keys alike', () => {
    const raw = {
      ...exampleConfig,
      lanes: {
        oc: {
          run: ['node', 'tools/oc.js'],
          api: 'http://127.0.0.1:6096',
          customLaneKey: 'keep-me',
          health: { path: '/h', timeout: 5 },
        },
      },
    };
    const d = toDrafts(raw);
    const lane = laneAt(d, 0);
    expect(lane.originalId).toBe('oc');

    lane.id = 'oc2';
    const saved = toRaw(raw, d);
    expect('oc' in (saved.lanes as Record<string, unknown>)).toBe(false);
    const renamed = laneOf(saved, 'oc2');
    expect(renamed.customLaneKey).toBe('keep-me');
    expect(renamed.health).toEqual({ path: '/h', timeout: 5 });
  });

  describe('malformed health (R1): preserved until explicit disable or repair', () => {
    const malformedShapes: Array<[string, unknown]> = [
      ['a bare string', 'bad'],
      ['an array', []],
      ['null', null],
      ['an empty object', {}],
      ['an empty path', { path: '' }],
      ['unknown keys only, no path', { timeout: 5 }],
      // R1b: any JSON type class other than a non-blank string is malformed by the same generic rule
      // (`typeof path === 'string' && path.trim() !== ''`), not a per-shape allowlist — this is the fix, not
      // a growing list of special cases: null and [] used to fall through String() coercion into an empty
      // "usable" draft and vanish on save; every other non-string type is tested here so nothing new can slip
      // through the same hole.
      ['a null path', { path: null }],
      ['an empty array path', { path: [] }],
      ['a non-empty array path', { path: ['/x'] }],
      ['a true path', { path: true }],
      ['a false path', { path: false }],
      ['a number path', { path: 42 }],
      ['a zero path', { path: 0 }],
      ['a plain-object path', { path: {} }],
      ['a whitespace-only string path', { path: '   ' }],
    ];

    it.each(malformedShapes)('%s round trips untouched instead of being silently dropped', (_label, healthValue) => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: healthValue } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);

      // Nothing to show in the normal fields — the value is not lost, it lives in healthMalformed instead.
      expect(lane.healthPath).toBe('');
      expect(lane.healthJson).toBe('');
      expect(lane.healthMalformed).toEqual(healthValue);
      expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/健康检查写法不对/);

      // A save that never touches this lane's health must not turn "broken" into "gone".
      const saved = toRaw(raw, d);
      expect(laneOf(saved, 'oc').health).toEqual(healthValue);
    });

    // R1c: an invalid path must not hide an independent, editable sibling `json` — across every JSON type
    // class the path can be malformed as, and every shape the json itself can take (valid, invalid — nested
    // or wrong type —, with or without an unrelated unknown key alongside it).
    describe('R1c: an invalid path does not hide a sibling json', () => {
      const badPaths: Array<[string, unknown]> = [
        ['null', null],
        ['an array', []],
        ['a boolean', true],
        ['a number', 42],
        ['an object', {}],
        ['a blank string', '   '],
      ];
      const jsonVariants: Array<[string, unknown, 'valid' | 'invalid']> = [
        ['a valid json object', { healthy: true }, 'valid'],
        ['a nested json object (field values must be primitives)', { a: { b: 1 } }, 'invalid'],
        ['a non-object json (wrong type)', 'bad', 'invalid'],
      ];

      for (const [pathLabel, pathValue] of badPaths) {
        for (const [jsonLabel, jsonValue, jsonKind] of jsonVariants) {
          for (const withUnknown of [false, true]) {
            const shapeLabel = `path is ${pathLabel} with ${jsonLabel}${withUnknown ? ' and an unknown sibling' : ''}`;
            const rawHealth: Record<string, unknown> = { path: pathValue, json: jsonValue };
            if (withUnknown) rawHealth.timeout = 5;

            it(`${shapeLabel}: json is visible on load and round trips untouched`, () => {
              const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: rawHealth } } };
              const d = toDrafts(raw);
              const lane = laneAt(d, 0);

              expect(lane.healthPath).toBe('');
              expect(lane.healthJson).toBe(JSON.stringify(jsonValue));
              expect(lane.healthMalformed).toEqual(rawHealth);

              // A save that never touches this lane's health keeps every field, json included.
              const saved = toRaw(raw, d);
              expect(laneOf(saved, 'oc').health).toEqual(rawHealth);
            });

            it(`${shapeLabel}: repairing the path changes only the path`, () => {
              const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: rawHealth } } };
              const d = toDrafts(raw);
              const lane = laneAt(d, 0);
              lane.healthPath = '/global/health';

              const saved = toRaw(raw, d);
              const expected = { ...rawHealth, path: '/global/health' };
              if (jsonKind === 'valid') {
                expect(laneOf(saved, 'oc').health).toEqual(expected);
                expect(validateDrafts(d)['lanes.0.healthJson']).toBeUndefined();
                expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();
              } else {
                // The invalid json blocks the save with its own error — it stays visible as text, it is not
                // silently written as an unmatchable (or missing) health check.
                expect(validateDrafts(d)['lanes.0.healthJson']).toBeTruthy();
              }
            });
          }
        }
      }
    });

    it('R1c: clearing the json field explicitly (leaving the path unrepaired) removes json but keeps the rest of the malformed value visible as text', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: null, json: { healthy: true }, timeout: 5 } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      expect(lane.healthJson).toBe('{"healthy":true}');

      // What LaneCard sends when the owner clears the textarea by hand.
      lane.healthJson = '';
      // Still malformed (path untouched), so the whole original value is kept verbatim — clearing the json
      // textarea without repairing the path is not a way to edit the saved value, only unchecking is.
      const saved = toRaw(raw, d);
      expect(laneOf(saved, 'oc').health).toEqual({ path: null, json: { healthy: true }, timeout: 5 });
    });

    it('R1c: unchecking drops the preserved json along with the rest of the malformed value; rechecking does not restore it', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: null, json: { healthy: true }, timeout: 5 } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      expect(lane.healthJson).toBe('{"healthy":true}');

      // What LaneCard's toggleHealth(false) sends as the patch.
      lane.healthPath = '';
      lane.healthJson = '';
      lane.healthMalformed = undefined;
      expect('health' in laneOf(toRaw(raw, d), 'oc')).toBe(false);

      // Rechecking (toggleHealth(true)) does not read the file again — the box reopens empty.
      expect(lane.healthPath).toBe('');
      expect(lane.healthJson).toBe('');
      expect(lane.healthMalformed).toBeUndefined();
    });

    it('R1c: reset (reload from file) restores the json exactly as it was before any edit', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: null, json: { healthy: true }, timeout: 5 } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      lane.healthJson = '';
      lane.healthPath = 'abc';

      // "放弃未保存修改" rebuilds drafts from the original raw file, discarding every in-progress edit.
      const reloaded = toDrafts(raw);
      const reloadedLane = laneAt(reloaded, 0);
      expect(reloadedLane.healthJson).toBe('{"healthy":true}');
      expect(reloadedLane.healthPath).toBe('');
      expect(reloadedLane.healthMalformed).toEqual({ path: null, json: { healthy: true }, timeout: 5 });
    });

    it('unchecking (explicit disable) drops the malformed value instead of keeping it hidden', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { timeout: 5 } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      // What LaneCard's toggleHealth(false) sends as the patch.
      lane.healthPath = '';
      lane.healthJson = '';
      lane.healthMalformed = undefined;

      const saved = toRaw(raw, d);
      expect('health' in laneOf(saved, 'oc')).toBe(false);
    });

    it('typing a working path (repair) keeps sibling unknown keys when the original was at least an object', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { timeout: 5 } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      lane.healthPath = '/global/health';

      const saved = toRaw(raw, d);
      expect(laneOf(saved, 'oc').health).toEqual({ timeout: 5, path: '/global/health' });
      expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();
    });

    it('typing a working path (repair) discards an unusable root shape (nothing recoverable in a string/array/null)', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: 'bad' } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      lane.healthPath = '/global/health';

      const saved = toRaw(raw, d);
      expect(laneOf(saved, 'oc').health).toEqual({ path: '/global/health' });
    });

    it('describeMalformedHealth names each shape distinctly enough to act on', () => {
      expect(describeMalformedHealth('bad')).toMatch(/对象/);
      expect(describeMalformedHealth([])).toMatch(/数组/);
      expect(describeMalformedHealth(null)).toMatch(/null/);
      expect(describeMalformedHealth({})).toMatch(/path/);
      expect(describeMalformedHealth({ path: '' })).toMatch(/path/);
      expect(describeMalformedHealth({ timeout: 5 })).toMatch(/path/);
    });

    it('a non-string path (e.g. 42) is malformed like any other non-string — no longer coerced into "42" as if it were legitimate draft text', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: 42 } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      expect(lane.healthPath).toBe('');
      expect(lane.healthMalformed).toEqual({ path: 42 });
      expect(describeMalformedHealth(lane.healthMalformed)).toMatch(/字符串/);
      expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/写法不对/);

      // A repair still works the same as for any other malformed shape.
      lane.healthPath = '/global/health';
      expect(validateDrafts(d)['lanes.0.healthPath']).toBeUndefined();
      expect(laneOf(toRaw(raw, d), 'oc').health).toEqual({ path: '/global/health' });
    });

    it('a valid string path is not malformed, and a badly-formatted (but string) path is editable text with its own format error', () => {
      const raw = { ...exampleConfig, lanes: { oc: { run: ['node', 'tools/oc.js'], api: 'http://127.0.0.1:6096', health: { path: 'not-a-slash-path' } } } };
      const d = toDrafts(raw);
      const lane = laneAt(d, 0);
      expect(lane.healthPath).toBe('not-a-slash-path');
      expect(lane.healthMalformed).toBeUndefined();
      expect(validateDrafts(d)['lanes.0.healthPath']).toMatch(/相对路径/);
    });

    it('a valid path alongside a deleted-lane-shaped originalId (should-fix): added lane never inherits a same-id lane\'s unknown fields', () => {
      const raw = {
        ...exampleConfig,
        lanes: { keep: { run: ['node', 'x.js'] }, 'lane-2': { run: ['node', 'y.js'], extraKey: 'from-lane-2' } },
      };
      const d = toDrafts(raw);
      // Owner deletes lane-2, then adds a fresh lane; SettingsLanesSection's id generator can reuse the same
      // string ('lane-2') once the list is back down to one lane, but the new draft carries originalId: null.
      const kept = d.lanes.filter((lane) => lane.id === 'keep');
      const added: LaneDraft = {
        id: 'lane-2',
        formKey: 'form-added-test',
        originalId: null,
        run: ['node', 'scripts/run-worker.mjs', '--lane', 'lane-2'],
        outputDir: '.questboard-data/workers/lane-2',
        api: '',
        serve: [],
        deliveryDir: '',
        defaultModel: '',
        editCounter: '',
        serialize: false,
        spacingMs: '',
        env: '',
        sessionRun: [],
        sessionSaveTo: '',
        healthPath: '',
        healthJson: '',
      };
      const next: SettingsDrafts = { ...d, lanes: [...kept, added] };
      const saved = toRaw(raw, next);
      expect('extraKey' in laneOf(saved, 'lane-2')).toBe(false);
    });
  });

  it('rule 17: each lane draft gets a stable formKey independent of its editable id, unaffected by rename', () => {
    const raw = { ...exampleConfig, lanes: { a: { run: ['x'] }, b: { run: ['y'] } } };
    const d = toDrafts(raw);
    const keyA = laneAt(d, 0).formKey;
    const keyB = laneAt(d, 1).formKey;
    expect(keyA).toBeTruthy();
    expect(keyB).toBeTruthy();
    expect(keyA).not.toBe(keyB);

    // Renaming the lane's editable id does not change its formKey.
    const lane = laneAt(d, 0);
    lane.id = 'renamed';
    expect(laneAt(d, 0).formKey).toBe(keyA);

    // Reloading (what "放弃未保存修改" does) rebuilds drafts from scratch, so each lane gets a fresh formKey —
    // this is what forces the LaneCard for that slot to remount instead of inheriting a sibling's local state.
    const reloaded = toDrafts(raw);
    expect(laneAt(reloaded, 0).formKey).not.toBe(keyA);
    expect(laneAt(reloaded, 1).formKey).not.toBe(keyB);
  });

  it('rule 19: blank optional args and omitWhen values produce save-blocking field errors', () => {
    const raw = {
      ...exampleConfig,
      lanes: {
        opt: {
          run: ['node', 'worker.js'],
          outputDir: 'out',
          optionalArgs: [{ when: 'variant', args: ['--effort', '{variant}', ''], omitWhen: ['   '], insertAt: 2 }],
        },
      },
    };
    const drafts = toDrafts(raw);
    const errors = validateDrafts(drafts);
    expect(errors['lanes.0.optionalArgs[0].args']).toMatch(/不能为空|空白/);
    expect(errors['lanes.0.optionalArgs[0].omitWhen']).toMatch(/不能为空|空白/);
    expect(Object.keys(errors).some((key) => key.startsWith('lanes.0.optionalArgs[0]'))).toBe(true);
  });

  it('rule 20: malformed and partial optional groups stay raw and are never coerced on load', () => {
    const partial = { when: 'variant', args: ['--effort', '{variant}'] };
    const malformed = { when: 'model', args: ['--effort', '{variant}'], insertAt: '3', futureFlag: true };
    const raw = {
      ...exampleConfig,
      lanes: { opt: { run: ['node', 'worker.js'], outputDir: 'out', optionalArgs: [partial, malformed, 'not-an-object'] } },
    };
    const drafts = toDrafts(raw);
    const lane = laneAt(drafts, 0);
    const first = lane.optionalArgs?.[0];
    const second = lane.optionalArgs?.[1];
    const third = lane.optionalArgs?.[2];
    expect(first?.insertAt).toBeUndefined();
    expect(second?.when).toBe('model');
    expect(second?.parseError).toContain('无法解析，已原样保留');
    expect(third?.parseError).toContain('无法解析，已原样保留');
    expect(validateDrafts(drafts)['lanes.0.optionalArgs[1].parse']).toContain('无法解析，已原样保留');
    expect(toRaw(raw, drafts)).toEqual(raw);
  });
});

describe('settingsForm usage section (feedback 36)', () => {
  const rawWithUsage = {
    ...exampleConfig,
    usage: {
      manualProviders: ['nvidia', 'claude-subscription'],
      alibaba: { edition: 'personal', region: 'cn-beijing', futureKey: 'keep' },
      futureUsageKey: 7,
    },
  };

  it('reads the section into drafts', () => {
    const d = toDrafts(rawWithUsage);
    expect(d.usage).toEqual({
      manualProviders: ['nvidia', 'claude-subscription'],
      alibabaEdition: 'personal',
      alibabaRegion: 'cn-beijing',
    });
  });

  it('trims hand-written manual provider ids while reading, like the service does', () => {
    const d = toDrafts({ usage: { manualProviders: [' nvidia ', 'claude-subscription'] } });
    expect(d.usage.manualProviders).toEqual(['nvidia', 'claude-subscription']);
  });

  it('round trips with unknown usage fields preserved', () => {
    const d = toDrafts(rawWithUsage);
    expect(toRaw(rawWithUsage, d).usage).toEqual({
      manualProviders: ['nvidia', 'claude-subscription'],
      alibaba: { edition: 'personal', region: 'cn-beijing', futureKey: 'keep' },
      futureUsageKey: 7,
    });
  });

  it('writes an empty manual list as a real choice, and drops alibaba when either half is cleared', () => {
    const d = toDrafts(rawWithUsage);
    d.usage.manualProviders = [];
    d.usage.alibabaRegion = '';
    const usage = toRaw(rawWithUsage, d).usage as Record<string, unknown>;
    expect(usage.manualProviders).toEqual([]);
    expect('alibaba' in usage).toBe(false);
    expect(usage.futureUsageKey).toBe(7);
  });

  it('does not invent a usage key for a project that never had one', () => {
    const d = toDrafts(exampleConfig);
    const result = toRaw(exampleConfig, d);
    expect('usage' in result).toBe(false);
  });

  it('refuses a half-set Alibaba pair and accepts a full one', () => {
    const d = toDrafts(rawWithUsage);
    d.usage.alibabaRegion = '';
    expect(validateDrafts(d)['usage.alibaba']).toMatch(/要么都选，要么都不选/);

    d.usage.alibabaRegion = 'cn-beijing';
    d.usage.alibabaEdition = '';
    expect(validateDrafts(d)['usage.alibaba']).toBeDefined();

    d.usage.alibabaEdition = 'personal';
    expect(validateDrafts(d)['usage.alibaba']).toBeUndefined();
  });

  it('accepts a project with no usage settings at all', () => {
    const d = toDrafts(exampleConfig);
    expect(validateDrafts(d)['usage.alibaba']).toBeUndefined();
  });
});
