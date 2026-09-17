import { describe, expect, it } from 'vitest';
import { TRANSLATIONS } from './i18n';

/**
 * Byte-identical Chinese guard.
 *
 * `i18nZhSnapshot.fixture.json`, committed beside this test, records the zh value of every
 * dictionary key. The test fails — never skips — when that fixture is missing, unreadable, or
 * different in any way: a changed zh value, a key added without regenerating the fixture, or a
 * stale fixture entry for a key that no longer exists. That keeps the Chinese rendering provably
 * unchanged unless the fixture diff is reviewed on purpose.
 *
 * Regenerating on purpose (from web/), review the `git diff` of the fixture and commit it with
 * the dictionary change that motivated it:
 *
 *   Git Bash:  UPDATE_I18N_ZH_FIXTURE=1 npx.cmd vitest run src/lib/i18nZhSnapshot.test.ts
 *   cmd.exe:   set UPDATE_I18N_ZH_FIXTURE=1&& npx.cmd vitest run src/lib/i18nZhSnapshot.test.ts
 *
 * The repo has no @types/node, so the built-in modules are fetched through non-literal dynamic
 * imports (left unresolved at the type level) and narrowed locally.
 */
interface FsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
  writeFileSync(path: string, data: string): void;
}

interface PathModule {
  join(...parts: string[]): string;
  dirname(path: string): string;
}

interface UrlModule {
  fileURLToPath(url: string): string;
}

const fsSpecifier: string = 'node:fs';
const pathSpecifier: string = 'node:path';
const urlSpecifier: string = 'node:url';
const fs = (await import(fsSpecifier)) as FsModule;
const pathMod = (await import(pathSpecifier)) as PathModule;
const urlMod = (await import(urlSpecifier)) as UrlModule;
const processLike = (globalThis as { process?: { cwd?: () => string; env?: Record<string, string | undefined> } }).process;

const MODULE_URL = (import.meta as unknown as { url?: string }).url;

function locateTestDirectory(): string {
  const cwd = processLike?.cwd?.() ?? '.';
  if (typeof MODULE_URL === 'string' && MODULE_URL.length > 0) {
    return pathMod.dirname(urlMod.fileURLToPath(MODULE_URL));
  }
  const candidates = ['src/lib', 'web/src/lib'].map((relative) => pathMod.join(cwd, relative));
  const withTest = candidates.find((dir) => fs.existsSync(pathMod.join(dir, 'i18nZhSnapshot.test.ts')));
  return withTest ?? pathMod.join(cwd, 'src', 'lib');
}

const FIXTURE_PATH = pathMod.join(locateTestDirectory(), 'i18nZhSnapshot.fixture.json');
const UPDATE_REQUESTED = processLike?.env?.UPDATE_I18N_ZH_FIXTURE === '1';

function currentZhSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const key of (Object.keys(TRANSLATIONS) as Array<keyof typeof TRANSLATIONS>).sort()) {
    snapshot[key] = TRANSLATIONS[key].zh;
  }
  return snapshot;
}

const CURRENT = currentZhSnapshot();

if (UPDATE_REQUESTED) {
  fs.writeFileSync(FIXTURE_PATH, `${JSON.stringify(CURRENT, null, 2)}\n`);
}

describe('Chinese dictionary snapshot matches the committed fixture', () => {
  const fixtureExists = fs.existsSync(FIXTURE_PATH);
  let parseError: string | null = null;
  let fixture: Record<string, string> = {};
  if (fixtureExists) {
    try {
      fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Record<string, string>;
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  it('has a valid committed fixture beside this test file', () => {
    expect({ fixture: FIXTURE_PATH, present: fixtureExists, parseError }).toEqual({
      fixture: FIXTURE_PATH,
      present: true,
      parseError: null,
    });
  });

  it('keeps every zh value byte-identical to the fixture, with no extra or missing keys', () => {
    const differences: string[] = [];
    for (const key of Object.keys(CURRENT).sort()) {
      const recorded = fixture[key];
      if (recorded === undefined) differences.push(`missing from fixture: ${key}`);
      else if (recorded !== CURRENT[key]) differences.push(`zh value changed: ${key}`);
    }
    for (const key of Object.keys(fixture).sort()) {
      if (!(key in CURRENT)) differences.push(`stale fixture entry: ${key}`);
    }
    expect(differences).toEqual([]);
  });
});
