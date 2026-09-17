import { describe, expect, it } from 'vitest';

// questboard is a generic tool for any project, so its interface must not carry one project's theme (the
// salvage/pit wording it was first built with). Case-insensitive: a lowercase or mixed-case slip (a CSS
// comment, a code fence) is just as much a leftover as the shouted form.
const sources = import.meta.glob<string>(['../**/*.ts', '../**/*.tsx', '!./genericWording.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

const FORBIDDEN = ['salvage', 'in the pit', 'hauled up'];

// public/ is the classic board UI, a sibling of web/ at the repo root — outside the Vite project root that
// import.meta.glob walks, so it is read directly the way i18nZhSnapshot.test.ts reads its fixture: dynamic
// node: imports, resolved relative to this file rather than through the module graph. web/src/**/*.css is
// read the same way (not through import.meta.glob's `?raw` query): that combination silently resolves every
// CSS file to an empty string in this Vite/Vitest setup, which would make the guard pass on an untouched
// stylesheet — so CSS is scanned on disk, where a leftover can't hide behind a transform quirk.
interface DirentLike {
  name: string;
  isDirectory(): boolean;
}
interface FsModule {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: string): string;
  readdirSync(path: string, options: { withFileTypes: true }): DirentLike[];
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

const MODULE_URL = (import.meta as unknown as { url?: string }).url;
const HERE = typeof MODULE_URL === 'string' && MODULE_URL.length > 0 ? pathMod.dirname(urlMod.fileURLToPath(MODULE_URL)) : '.';
// web/src/lib -> web/src -> web -> repo root -> public
const PUBLIC_DIR = pathMod.join(HERE, '..', '..', '..', 'public');
// web/src/lib -> web/src
const WEB_SRC_DIR = pathMod.join(HERE, '..');

// Walks `dir` on disk and returns every matching file's text, keyed by `${label}/relative/path`. A missing
// root fails loudly (throws) instead of silently scanning nothing, so a moved or renamed folder can't leave
// a whole surface unchecked forever.
function readSourcesFromDisk(dir: string, label: string, extensions: RegExp): Record<string, string> {
  if (!fs.existsSync(dir)) {
    throw new Error(`generic wording guard: expected ${label} at ${dir}, found nothing to scan`);
  }
  const out: Record<string, string> = {};
  const walk = (current: string, relPrefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = pathMod.join(current, entry.name);
      const rel = `${relPrefix}${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, `${rel}/`);
        continue;
      }
      if (!extensions.test(entry.name)) continue;
      out[`${label}/${rel}`] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

const readPublicSources = (): Record<string, string> => readSourcesFromDisk(PUBLIC_DIR, 'public', /\.(html|css|js|ts|tsx)$/);
const readCssSources = (): Record<string, string> => readSourcesFromDisk(WEB_SRC_DIR, 'web/src', /\.css$/);

describe('generic wording guard', () => {
  it('keeps salvage and pit wording out of web/src and public/', () => {
    const publicFiles = readPublicSources();
    const cssFiles = readCssSources();
    const files = { ...sources, ...cssFiles, ...publicFiles };
    const entries = Object.entries(files);
    expect(entries.length).toBeGreaterThan(20);
    // Prove the two extra surfaces are actually being read, not just present in an empty scan result.
    expect(Object.keys(publicFiles).length).toBeGreaterThan(0);
    expect(Object.keys(cssFiles).filter((file) => file.includes('/styles/')).length).toBeGreaterThan(0);
    const violations = entries.flatMap(([file, text]) => {
      const lower = text.toLowerCase();
      return FORBIDDEN.filter((phrase) => lower.includes(phrase)).map((phrase) => `${file} contains "${phrase}"`);
    });
    expect(violations).toEqual([]);
  });
});
