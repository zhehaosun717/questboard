import { describe, expect, it } from 'vitest';
import { TRANSLATIONS } from './i18n';

/**
 * Byte-identical Chinese guard, run against the pre-change evidence captured before any conversion
 * (unique quoted Chinese literals per file, read from the worktree at the base commit). Every captured
 * literal must still exist word-for-word — either inside a dictionary value or, for files that stay as
 * they were, inside the file itself. Interpolations are folded away on both sides (`${x}` / `{x}` -> `{}`),
 * so a literal may move from a template string into the dictionary as long as its Chinese text survives.
 *
 * The repo has no @types/node, so the built-in modules are fetched through non-literal dynamic imports
 * (left unresolved at the type level) and narrowed locally.
 */
interface FsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
}

interface PathModule {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}

const fsSpecifier: string = 'node:fs';
const pathSpecifier: string = 'node:path';
const fs = (await import(fsSpecifier)) as FsModule;
const pathMod = (await import(pathSpecifier)) as PathModule;
const processLike = (globalThis as { process?: { cwd?: () => string } }).process;

const SNAPSHOT_PATH = 'C:/Users/A/AppData/Local/Temp/opencode/qb-i18n/zh-literals.json';
const REPO_ROOT = pathMod.resolve(processLike?.cwd?.() ?? '.', '..');
const HAS_SNAPSHOT = fs.existsSync(SNAPSHOT_PATH);

function normalize(text: string): string {
  return text
    .replace(/\$\{[^}]*\}?/g, '{}')
    .replace(/\{[a-zA-Z][a-zA-Z0-9]*\}/g, '{}')
    .replace(/\{\{+/g, '{')
    .replace(/\}+/g, '}');
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

describe.skipIf(!HAS_SNAPSHOT)('Chinese text matches the pre-change snapshot', () => {
  const snapshot = HAS_SNAPSHOT
    ? (JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as Record<string, string[]>)
    : {};
  const dictionary = Object.values(TRANSLATIONS).map((entry) => normalize(entry.zh));
  const sourceCache = new Map<string, string>();

  function sourceOf(file: string): string {
    let source = sourceCache.get(file);
    if (source === undefined) {
      const absolute = pathMod.join(REPO_ROOT, file);
      source = fs.existsSync(absolute) ? normalize(fs.readFileSync(absolute, 'utf8')) : '';
      sourceCache.set(file, source);
    }
    return source;
  }

  it('keeps every captured Chinese literal in the dictionary or in its original file', () => {
    const missing: string[] = [];
    for (const [file, literals] of Object.entries(snapshot)) {
      const source = sourceOf(file);
      for (const literal of literals) {
        if (!hasChinese(literal)) continue;
        const needle = normalize(literal);
        const inDictionary = dictionary.some((value) => value.includes(needle));
        if (!inDictionary && !source.includes(needle)) {
          missing.push(`${file}: ${literal}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
